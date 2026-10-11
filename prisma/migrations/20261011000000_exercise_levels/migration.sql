-- Exercise frequency now uses the five activity levels of tdeecalculator.net.
-- WorkoutsPerWeek ('0-2', '3-5', '6+') is folded into ActivityLevel, which gains 'sedentary', 'heavy' and 'athlete'.
-- Existing rows keep their multiplier: 0-2 -> light (1.375), 3-5 -> moderate (1.55), 6+ -> heavy (1.725).

ALTER TYPE "ActivityLevel" RENAME TO "ActivityLevel_old";
CREATE TYPE "ActivityLevel" AS ENUM ('sedentary', 'light', 'moderate', 'heavy', 'athlete');

ALTER TABLE "Profile"
  ALTER COLUMN "workoutsPerWeek" TYPE "ActivityLevel"
  USING (CASE "workoutsPerWeek"::text WHEN '0-2' THEN 'light' WHEN '3-5' THEN 'moderate' ELSE 'heavy' END)::"ActivityLevel",
  ALTER COLUMN "activityLevel" TYPE "ActivityLevel"
  USING (CASE "activityLevel"::text WHEN 'active' THEN 'heavy' ELSE "activityLevel"::text END)::"ActivityLevel";

DROP TYPE "ActivityLevel_old";
DROP TYPE "WorkoutsPerWeek";
