import { Body, Controller, Get, HttpCode, HttpException, HttpStatus, Param, Post } from '@nestjs/common';
import { UsersService } from './users.service';

interface UpsertBody {
  openid: string;
  regular_members?: number;
  stoves?: Array<{ type: string; count: number }>;
  pots?: string[];
  allergies?: string[];
  taboos?: string[];
  flavors?: string[];
  voice_control_on?: boolean;
}

@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get(':openid')
  @HttpCode(200)
  async getProfile(@Param('openid') openid: string) {
    try {
      const profile = await this.usersService.getOrCreate(openid);
      return { code: 200, msg: 'success', data: profile };
    } catch (e) {
      console.error('[users][get]', (e as Error).message);
      throw new HttpException(
        { code: 500, msg: (e as Error).message || '获取用户档案失败', data: null },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post('upsert')
  @HttpCode(200)
  async upsertProfile(@Body() body: UpsertBody) {
    if (!body?.openid) {
      throw new HttpException({ code: 400, msg: 'openid 不能为空', data: null }, HttpStatus.BAD_REQUEST);
    }
    try {
      const profile = await this.usersService.upsert(body.openid, {
        regular_members: body.regular_members,
        stoves: body.stoves,
        pots: body.pots,
        allergies: body.allergies,
        taboos: body.taboos,
        flavors: body.flavors,
        voice_control_on: body.voice_control_on,
      });
      return { code: 200, msg: 'success', data: profile };
    } catch (e) {
      console.error('[users][upsert]', (e as Error).message);
      throw new HttpException(
        { code: 500, msg: (e as Error).message || '保存用户档案失败', data: null },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}