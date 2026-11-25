import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { API, auditActions, bearer, createActiveAdmin, freshTotp, signInAdmin, testApp } from './helpers.js';
import { DEV_PLACEHOLDER_CONFIG } from '../src/modules/platformConfig/platformConfig.schema.js';
import { getCurrentConfig, requireFinancialConfig, saveConfigVersion } from '../src/modules/platformConfig/platformConfig.service.js';
import { withTransaction } from '../src/db/transaction.js';

const app = testApp();
const seedPlaceholder = () =>
  withTransaction((s) => saveConfigVersion({ values: DEV_PLACEHOLDER_CONFIG, isPlaceholder: true, createdBySystem: 'test' }, s));

describe('platform configuration', () => {
  it('production refuses financial use of placeholder values; development allows it', async () => {
    await seedPlaceholder();
    await expect(requireFinancialConfig()).resolves.toMatchObject({ isPlaceholder: true });
    await expect(requireFinancialConfig(undefined, { production: true })).rejects.toMatchObject({ code: 'config_placeholder' });

    // Once a Super Admin saves real values, production may use them.
    await withTransaction((s) => saveConfigVersion({ values: DEV_PLACEHOLDER_CONFIG, isPlaceholder: false, createdBySystem: 'test' }, s));
    await expect(requireFinancialConfig(undefined, { production: true })).resolves.toMatchObject({ isPlaceholder: false, version: 2 });
  });

  it('with no configuration at all, financial actions are refused everywhere', async () => {
    await expect(requireFinancialConfig()).rejects.toMatchObject({ code: 'config_missing' });
  });

  it('a Super Admin saves real values as a new version, audited with before and after', async () => {
    await seedPlaceholder();
    const sa = await createActiveAdmin('super_admin');
    const s = await signInAdmin(app, sa);
    const values = { ...DEV_PLACEHOLDER_CONFIG, shares: { ...DEV_PLACEHOLDER_CONFIG.shares, driver_on_demand: { platformBps: 3000, driverBps: 7000 } } };
    const res = await request(app)
      .put(`${API}/admin/config`)
      .set(bearer(s))
      .set('X-2FA-Code', await freshTotp(sa))
      .send({ values, note: 'Agreed with accountant' })
      .expect(200);
    expect(res.body.config).toMatchObject({ version: 2, isPlaceholder: false });
    const cur = await getCurrentConfig();
    expect(cur!.values.shares.driver_on_demand.platformBps).toBe(3000);
    expect(await auditActions()).toContain('config.updated');
  });

  it('rejects shares that do not add up to 100%, fractional shares and unknown fields', async () => {
    const sa = await createActiveAdmin('super_admin');
    const s = await signInAdmin(app, sa);
    const bad = [
      { ...DEV_PLACEHOLDER_CONFIG, shares: { ...DEV_PLACEHOLDER_CONFIG.shares, chauffeur: { platformBps: 2000, driverBps: 3000, vehicleOwnerBps: 4000 } } },
      { ...DEV_PLACEHOLDER_CONFIG, shares: { ...DEV_PLACEHOLDER_CONFIG.shares, driver_on_demand: { platformBps: 2500.5, driverBps: 7499.5 } } },
      { ...DEV_PLACEHOLDER_CONFIG, isPlaceholder: true },
      { ...DEV_PLACEHOLDER_CONFIG, cancellationTiers: [{ minHoursBeforePickup: 2, refundBps: 5000 }, { minHoursBeforePickup: 24, refundBps: 10000 }] },
    ];
    for (const values of bad) {
      const res = await request(app).put(`${API}/admin/config`).set(bearer(s)).set('X-2FA-Code', await freshTotp(sa)).send({ values });
      expect(res.status).toBe(400);
    }
    expect(await getCurrentConfig()).toBeNull();
  });

  it('ops admins can read but not change the configuration', async () => {
    await seedPlaceholder();
    const ops = await createActiveAdmin('staff');
    const s = await signInAdmin(app, ops);
    const res = await request(app).get(`${API}/admin/config`).set(bearer(s)).expect(200);
    expect(res.body.config.isPlaceholder).toBe(true);
    await request(app).put(`${API}/admin/config`).set(bearer(s)).send({ values: DEV_PLACEHOLDER_CONFIG }).expect(403);
  });
});
