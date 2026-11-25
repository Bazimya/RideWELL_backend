import { MongoMemoryReplSet } from 'mongodb-memory-server';
import type { TestProject } from 'vitest/node';

let replSet: MongoMemoryReplSet | null = null;

/** One in-memory replica set for the whole run: transactions behave as in production. */
export default async function setup(project: TestProject) {
  replSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' },
    binary: { version: process.env.MONGOMS_VERSION ?? '7.0.0' },
  });
  project.provide('mongoUri', replSet.getUri('ridewell_test'));
  return async () => {
    await replSet?.stop();
  };
}

declare module 'vitest' {
  export interface ProvidedContext {
    mongoUri: string;
  }
}
