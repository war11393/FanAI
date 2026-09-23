import { Module } from '@nestjs/common';
import { AppController } from '@/app.controller';
import { AppService } from '@/app.service';
import { UsersModule } from '@/modules/users/users.module';
import { AiModule } from '@/modules/ai/ai.module';
import { IngredientsModule } from '@/modules/ingredients/ingredients.module';
import { MealPlansModule } from '@/modules/meal-plans/meal-plans.module';
import { RecipesModule } from '@/modules/recipes/recipes.module';

@Module({
  imports: [UsersModule, AiModule, IngredientsModule, MealPlansModule, RecipesModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
