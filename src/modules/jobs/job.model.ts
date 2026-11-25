import { Schema, model, type InferSchemaType } from 'mongoose';

/** One row per recurring job: when it runs next and who currently holds its lease. */
const jobSchema = new Schema(
  {
    name: { type: String, required: true },
    nextRunAt: { type: Date, required: true },
    lockedBy: { type: String, default: null },
    lockedUntil: { type: Date, default: null },
    lastStartedAt: { type: Date, default: null },
    lastFinishedAt: { type: Date, default: null },
    lastError: { type: String, default: null },
    runCount: { type: Number, default: 0 },
  },
  { versionKey: false },
);

jobSchema.index({ name: 1 }, { unique: true });

export type Job = InferSchemaType<typeof jobSchema>;
export const JobModel = model('Job', jobSchema, 'jobs');
