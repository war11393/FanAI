import { Body, Controller, Get, HttpCode, HttpException, HttpStatus, Post, Query } from '@nestjs/common';
import { MealPlansService, MealPlan } from './meal-plans.service';

interface SaveBody {
  openid: string;
  id?: string;
  date?: string;
  diners_count?: number;
  selected_dishes?: Array<Record<string, unknown>>;
  prep_list?: Array<string>;
  cooking_steps?: Array<Record<string, unknown>>;
  status?: MealPlan['status'];
}

@Controller('meal-plans')
export class MealPlansController {
  constructor(private readonly mealPlansService: MealPlansService) {}

  @Get()
  @HttpCode(200)
  async list(@Query('openid') openid: string, @Query('status') status?: string) {
    if (!openid) {
      throw new HttpException({ code: 400, msg: 'openid 不能为空', data: null }, HttpStatus.BAD_REQUEST);
    }
    try {
      const data = await this.mealPlansService.list(openid, status);
      return { code: 200, msg: 'success', data };
    } catch (e) {
      console.error('[meal-plans][list]', (e as Error).message);
      throw new HttpException({ code: 500, msg: (e as Error).message, data: null }, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Post('save')
  @HttpCode(200)
  async save(@Body() body: SaveBody) {
    if (!body?.openid) {
      throw new HttpException({ code: 400, msg: 'openid 不能为空', data: null }, HttpStatus.BAD_REQUEST);
    }
    try {
      const plan: MealPlan = {
        openid: body.openid,
        id: body.id,
        date: body.date || new Date().toISOString().slice(0, 10),
        diners_count: body.diners_count ?? 2,
        selected_dishes: body.selected_dishes ?? [],
        prep_list: body.prep_list ?? [],
        cooking_steps: body.cooking_steps ?? [],
        status: body.status ?? 'done',
      };
      const data = await this.mealPlansService.save(plan);
      return { code: 200, msg: 'success', data };
    } catch (e) {
      console.error('[meal-plans][save]', (e as Error).message);
      throw new HttpException({ code: 500, msg: (e as Error).message, data: null }, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }
}