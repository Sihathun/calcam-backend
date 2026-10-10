-- CreateEnum
CREATE TYPE "DishKind" AS ENUM ('catalog', 'learned');

-- CreateEnum
CREATE TYPE "ComponentValueSource" AS ENUM ('catalog', 'learned', 'personal');

-- AlterTable
ALTER TABLE "Meal" ADD COLUMN     "imageSha256" TEXT,
ADD COLUMN     "nameKm" TEXT,
ADD COLUMN     "originalNutrition" JSONB,
ADD COLUMN     "userEditedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "FoodDish" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "kind" "DishKind" NOT NULL,
    "nameEn" TEXT NOT NULL,
    "nameKm" TEXT,
    "normalizedName" TEXT NOT NULL,
    "aliases" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "category" TEXT,
    "servingDescription" TEXT NOT NULL,
    "servingGrams" DOUBLE PRECISION,
    "calories" INTEGER NOT NULL,
    "proteinG" DOUBLE PRECISION NOT NULL,
    "carbsG" DOUBLE PRECISION NOT NULL,
    "fatG" DOUBLE PRECISION NOT NULL,
    "healthScore" INTEGER NOT NULL,
    "confidence" TEXT,
    "sources" JSONB,
    "createdFromMealId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FoodDish_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MealComponent" (
    "id" UUID NOT NULL,
    "mealId" UUID NOT NULL,
    "dishId" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "portion" DOUBLE PRECISION NOT NULL,
    "calories" INTEGER NOT NULL,
    "proteinG" DOUBLE PRECISION NOT NULL,
    "carbsG" DOUBLE PRECISION NOT NULL,
    "fatG" DOUBLE PRECISION NOT NULL,
    "healthScore" INTEGER NOT NULL,
    "valueSource" "ComponentValueSource" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MealComponent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserDishOverride" (
    "userId" UUID NOT NULL,
    "dishId" UUID NOT NULL,
    "calories" INTEGER NOT NULL,
    "proteinG" DOUBLE PRECISION NOT NULL,
    "carbsG" DOUBLE PRECISION NOT NULL,
    "fatG" DOUBLE PRECISION NOT NULL,
    "sourceMealId" UUID,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserDishOverride_pkey" PRIMARY KEY ("userId","dishId")
);

-- CreateIndex
CREATE UNIQUE INDEX "FoodDish_slug_key" ON "FoodDish"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "FoodDish_normalizedName_key" ON "FoodDish"("normalizedName");

-- CreateIndex
CREATE INDEX "FoodDish_kind_idx" ON "FoodDish"("kind");

-- CreateIndex
CREATE INDEX "MealComponent_mealId_idx" ON "MealComponent"("mealId");

-- CreateIndex
CREATE INDEX "MealComponent_dishId_idx" ON "MealComponent"("dishId");

-- CreateIndex
CREATE INDEX "Meal_userId_imageSha256_idx" ON "Meal"("userId", "imageSha256");

-- AddForeignKey
ALTER TABLE "MealComponent" ADD CONSTRAINT "MealComponent_mealId_fkey" FOREIGN KEY ("mealId") REFERENCES "Meal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MealComponent" ADD CONSTRAINT "MealComponent_dishId_fkey" FOREIGN KEY ("dishId") REFERENCES "FoodDish"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserDishOverride" ADD CONSTRAINT "UserDishOverride_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserDishOverride" ADD CONSTRAINT "UserDishOverride_dishId_fkey" FOREIGN KEY ("dishId") REFERENCES "FoodDish"("id") ON DELETE CASCADE ON UPDATE CASCADE;
