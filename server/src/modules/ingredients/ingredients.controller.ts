import {
  Controller, Get, Post, Put, Delete, Body, Param, Query, HttpCode,
  UseInterceptors, UploadedFile, HttpException, HttpStatus,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { IngredientsService, IngredientInput } from './ingredients.service';
import { AiService } from '../ai/ai.service';

const fs = require('fs');

@Controller('ingredients')
export class IngredientsController {
  constructor(
    private readonly ingredients: IngredientsService,
    private readonly ai: AiService,
  ) {}

  /** 查询食材列表（含新鲜度刷新） */
  @Get()
  @HttpCode(200)
  async list(@Query('openid') openid: string) {
    if (!openid) return { code: 400, msg: 'openid 不能为空', data: [] };
    await this.ingredients.refreshStatuses(openid);
    const data = await this.ingredients.list(openid);
    return { code: 200, msg: 'success', data };
  }

  /** 新增单个食材 */
  @Post()
  @HttpCode(200)
  async create(@Body() body: IngredientInput & { openid?: string }) {
    const openid = body.openid;
    if (!openid) return { code: 400, msg: 'openid 不能为空', data: null };
    try {
      const data = await this.ingredients.add(openid, body);
      return { code: 200, msg: 'success', data };
    } catch (e) {
      throw new HttpException((e as Error).message, HttpStatus.BAD_REQUEST);
    }
  }

  /** 批量新增 */
  @Post('batch')
  @HttpCode(200)
  async batch(@Body() body: { openid?: string; items?: IngredientInput[] }) {
    if (!body.openid) return { code: 400, msg: 'openid 不能为空', data: [] };
    try {
      const data = await this.ingredients.batchAdd(body.openid, body.items ?? []);
      return { code: 200, msg: 'success', data };
    } catch (e) {
      throw new HttpException((e as Error).message, HttpStatus.BAD_REQUEST);
    }
  }

  /** 更新食材 */
  @Put(':id')
  @HttpCode(200)
  async update(@Param('id') id: string, @Body() body: Partial<IngredientInput> & { openid?: string }) {
    const openid = body.openid;
    if (!openid) return { code: 400, msg: 'openid 不能为空', data: null };
    try {
      const data = await this.ingredients.update(openid, id, body);
      return { code: 200, msg: 'success', data };
    } catch (e) {
      throw new HttpException((e as Error).message, HttpStatus.NOT_FOUND);
    }
  }

  /** 删除食材 */
  @Delete(':id')
  @HttpCode(200)
  async remove(@Param('id') id: string, @Query('openid') openid: string) {
    if (!openid) return { code: 400, msg: 'openid 不能为空', data: null };
    try {
      const data = await this.ingredients.remove(openid, id);
      return { code: 200, msg: 'success', data };
    } catch (e) {
      throw new HttpException((e as Error).message, HttpStatus.NOT_FOUND);
    }
  }

  /**
   * 拍照识别并返回食材（不自动入库，前端确认后再 batch 入库）
   * multipart: file(图片) + openid
   */
  @Post('recognize-photo')
  @HttpCode(200)
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } }))
  async recognizePhoto(@UploadedFile() file: Express.Multer.File, @Body('openid') openid: string) {
    if (!file || (!file.buffer && !file.path)) {
      throw new HttpException('未获取到图片文件', HttpStatus.BAD_REQUEST);
    }
    const buffer: Buffer = file.buffer ?? fs.readFileSync(file.path);
    const { imageKey, imageUrl } = await this.ingredients.uploadPhoto(buffer, file.originalname, file.mimetype);

    const result = (await this.ai.analyzeImage(
      imageUrl,
      `你是冰箱食材识别助手。请识别这张照片中的所有食材。
要求：只输出食材名称（标准中文名）、可估算的份量数量、单位（如 g/个/棵）、以及基于常温/冷藏的保质期天数（单位：天，合理估算）。
输出格式：{"items":[{"name":"土豆","quantity":3,"unit":"个","shelfLifeDays":30}]}。最多返回 8 项。
请只输出一个合法的 JSON 对象，不要输出任何解释、前言或 markdown 代码围栏。`,
    )) as any;

    const list = Array.isArray(result?.items) ? result.items : [];
    const normalized = list
      .filter((it: any) => it && it.name)
      .map((it: any) => ({
        name: String(it.name),
        quantity: Number(it.quantity) || 1,
        unit: String(it.unit || '个'),
        shelfLifeDays: Number(it.shelfLifeDays) || 3,
      }));
    return { code: 200, msg: 'success', data: { imageUrl, imageKey, items: normalized } };
  }
}