import { Body, Controller, Delete, Get, HttpCode, HttpException, HttpStatus, Param, Post, Query, Req } from '@nestjs/common';
import { RecipesService } from './recipes.service';
import { RecipeInput } from './recipes.service';
import { IncomingHttpHeaders, IncomingMessage } from 'http';

@Controller('recipes')
export class RecipesController {
  constructor(private readonly recipesService: RecipesService) {}

  // 初始化内置菜谱库（幂等）
  @Get('seed')
  @HttpCode(200)
  async seed() {
    try {
      const count = await this.recipesService.seedBuiltin();
      return { code: 200, msg: 'success', data: { seeded: count } };
    } catch (e) {
      throw new HttpException({ code: 500, msg: (e as Error).message, data: null }, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Get()
  @HttpCode(200)
  async list(@Query('openid') openid: string, @Query('keyword') keyword?: string) {
    if (!openid) {
      throw new HttpException({ code: 400, msg: 'openid 不能为空', data: null }, HttpStatus.BAD_REQUEST);
    }
    try {
      const data = await this.recipesService.list(openid, keyword);
      return { code: 200, msg: 'success', data };
    } catch (e) {
      console.error('[recipes][list]', (e as Error).message);
      throw new HttpException({ code: 500, msg: (e as Error).message, data: null }, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Post()
  @HttpCode(200)
  async create(@Body() body: RecipeInput) {
    try {
      const data = await this.recipesService.upsertPrivate(body);
      return { code: 200, msg: 'success', data };
    } catch (e) {
      console.error('[recipes][create]', (e as Error).message);
      throw new HttpException({ code: 500, msg: (e as Error).message, data: null }, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Post('from-text')
  @HttpCode(200)
  async createFromText(@Body() body: { openid: string; text: string }, @Req() req: IncomingMessage) {
    if (!body?.openid) {
      throw new HttpException({ code: 400, msg: 'openid 不能为空', data: null }, HttpStatus.BAD_REQUEST);
    }
    try {
      const headers: IncomingHttpHeaders = req.headers ?? {};
      const data = await this.recipesService.createFromText(body.openid, body.text, headers);
      return { code: 200, msg: 'success', data };
    } catch (e) {
      console.error('[recipes][from-text]', (e as Error).message);
      throw new HttpException({ code: 500, msg: (e as Error).message, data: null }, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Post(':id')
  @HttpCode(200)
  async update(@Param('id') id: string, @Body() body: RecipeInput) {
    try {
      const data = await this.recipesService.upsertPrivate(body, id);
      return { code: 200, msg: 'success', data };
    } catch (e) {
      console.error('[recipes][update]', (e as Error).message);
      throw new HttpException({ code: 500, msg: (e as Error).message, data: null }, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Delete(':id')
  @HttpCode(200)
  async remove(@Query('openid') openid: string, @Param('id') id: string) {
    if (!openid) {
      throw new HttpException({ code: 400, msg: 'openid 不能为空', data: null }, HttpStatus.BAD_REQUEST);
    }
    try {
      await this.recipesService.remove(openid, id);
      return { code: 200, msg: 'success', data: true };
    } catch (e) {
      console.error('[recipes][remove]', (e as Error).message);
      throw new HttpException({ code: 500, msg: (e as Error).message, data: null }, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }
}