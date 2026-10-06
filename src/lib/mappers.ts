import type { WorkoutsPerWeek as DbWorkouts } from '@prisma/client';
import type { WorkoutsPerWeek } from './enums';

// Prisma identifiers cannot contain "-" or "+", so the DB enum uses W0_2 etc.
const toDb: Record<WorkoutsPerWeek, DbWorkouts> = {
  '0-2': 'W0_2',
  '3-5': 'W3_5',
  '6+': 'W6_PLUS',
};
const fromDb: Record<DbWorkouts, WorkoutsPerWeek> = {
  W0_2: '0-2',
  W3_5: '3-5',
  W6_PLUS: '6+',
};

export const workoutsToDb = (v: WorkoutsPerWeek): DbWorkouts => toDb[v];
export const workoutsFromDb = (v: DbWorkouts): WorkoutsPerWeek => fromDb[v];
