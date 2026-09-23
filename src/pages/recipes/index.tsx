import { useCallback, useEffect, useState } from 'react';
import Taro from '@tarojs/taro';
import { View, Text, ScrollView } from '@tarojs/components';
import { Network } from '@/network';
import { getOpenid } from '@/utils/identity';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Search, BookOpen, Plus, Mic, Clock, ChefHat, Trash2, FileText } from 'lucide-react-taro';

interface Recipe {
  id?: string;
  openid?: string | null;
  name: string;
  category?: string;
  flavors?: string[];
  ingredients?: string[];
  main_steps?: string[];
  brief?: string;
  difficulty?: string;
  duration_minutes?: number;
  source?: string;
}
interface MealHistory {
  id: string;
  date: string;
  diners_count: number;
  selected_dishes: Array<{ name: string; [k: string]: unknown }>;
  status: string;
  created_at?: string;
}

export default function RecipesPage() {
  const openid = getOpenid();
  // 菜谱浏览
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [keyword, setKeyword] = useState('');
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  // 做菜历史
  const [history, setHistory] = useState<MealHistory[]>([]);
  // 创建弹窗
  const [createOpen, setCreateOpen] = useState(false);
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const [recording, setRecording] = useState(false);
  const isMiniApp = Taro.getEnv() === Taro.ENV_TYPE.WEAPP || Taro.getEnv() === Taro.ENV_TYPE.TT;

  const loadRecipes = useCallback(async (kw?: string) => {
    setLoading(true);
    try {
      const res: any = await Network.request({
        url: `/api/recipes?openid=${openid}${kw ? `&keyword=${encodeURIComponent(kw)}` : ''}`,
      });
      setRecipes(res.data?.data ?? []);
    } catch (e) {
      console.error('[recipes] load error', e);
      Taro.showToast({ title: '菜谱加载失败', icon: 'none' });
    } finally {
      setLoading(false);
    }
  }, [openid]);

  const loadHistory = useCallback(async () => {
    try {
      const res: any = await Network.request({ url: `/api/meal-plans?openid=${openid}&status=done` });
      setHistory(res.data?.data ?? []);
    } catch (e) {
      console.error('[history] load error', e);
    }
  }, [openid]);

  useEffect(() => {
    loadRecipes();
    loadHistory();
  }, [loadRecipes, loadHistory]);

  const onSearch = () => loadRecipes(keyword);

  const createRecipe = async () => {
    if (!text.trim()) {
      Taro.showToast({ title: '请输入菜谱内容', icon: 'none' });
      return;
    }
    setSaving(true);
    try {
      const res: any = await Network.request({
        url: '/api/recipes/from-text', method: 'POST',
        data: { openid, text },
      });
      const created = res.data?.data;
      if (created?.name) Taro.showToast({ title: '已保存私人菜谱', icon: 'success' });
      setText('');
      setCreateOpen(false);
      loadRecipes();
    } catch (e) {
      console.error('[recipes] create error', e);
      Taro.showToast({ title: '创建失败', icon: 'none' });
    } finally {
      setSaving(false);
    }
  };

  const deleteRecipe = async (id: string) => {
    try {
      await Network.request({ url: `/api/recipes/${id}?openid=${openid}`, method: 'DELETE' });
      Taro.showToast({ title: '已删除', icon: 'success' });
      loadRecipes();
    } catch (e) {
      console.error('[recipes] delete error', e);
      Taro.showToast({ title: '删除失败', icon: 'none' });
    }
  };

  const startRecord = () => {
    if (!isMiniApp) {
      Taro.showToast({ title: '语音仅小程序端可用', icon: 'none' });
      return;
    }
    if (recording) {
      Taro.showToast({ title: '正在录音中', icon: 'none' });
      return;
    }
    setRecording(true);
    const manager = Taro.getRecorderManager();
    manager.start({ format: 'wav', sampleRate: 16000, numberOfChannels: 1 });
    manager.onStop((res) => {
      setRecording(false);
      setText((prev) => (prev ? prev + '；' : '') + `（语音待识别：${res.duration ? Math.round(res.duration / 1000) : '?'}s —— 已接入微信同声传译插件后将自动转文字）`);
    });
    manager.onError(() => {
      setRecording(false);
      Taro.showToast({ title: '录音失败', icon: 'none' });
    });
  };

  return (
    <ScrollView scrollY className="bg-[#FAF3E7] w-full h-full">
      <View className="px-5 py-5 space-y-4 pb-32">
        {/* 顶部标题 + 新建 */}
        <View className="flex flex-row items-center justify-between">
          <View className="flex items-center gap-2">
            <BookOpen size={20} color="#FF8C42" />
            <Text className="block text-xl font-bold text-[#3E3226]">我的菜谱</Text>
          </View>
          <Button size="sm" className="bg-primary text-white rounded-full px-4 py-2 shadow" onClick={() => { setText(''); setCreateOpen(true); }}>
            <Plus size={16} color="#fff" className="mr-1" />
            新建
          </Button>
        </View>

        <Tabs defaultValue="recipes" className="w-full">
          <TabsList className="bg-[#FFF3E0] rounded-full p-1 w-full">
            <TabsTrigger value="recipes" className="rounded-full flex-1">菜谱库</TabsTrigger>
            <TabsTrigger value="history" className="rounded-full flex-1">做菜历史</TabsTrigger>
          </TabsList>

          {/* 菜谱库 */}
          <TabsContent value="recipes" className="pt-4 space-y-3">
            {/* 搜索 */}
            <View className="flex flex-row items-center gap-2">
              <View className="flex-1 bg-white rounded-2xl px-3 py-1 border border-orange-100">
                <Input placeholder="搜索菜名 / 食材..." value={keyword} onInput={(e) => setKeyword(e.detail.value)} onConfirm={onSearch} />
              </View>
              <Button size="sm" className="bg-[#FF8C42] rounded-full px-4" onClick={onSearch}>
                <Search size={16} color="#fff" />
              </Button>
            </View>

            {loading && <Text className="block text-center text-sm text-[#8B7D6E] py-8">加载中…</Text>}
            {!loading && recipes.length === 0 && (
              <Text className="block text-center text-sm text-[#8B7D6E] py-10">暂无菜谱，去新建一道属于你的菜吧</Text>
            )}

            {recipes.map((r, i) => {
              const key = r.id || `${r.name}-${i}`;
              const open = expanded === key;
              const isPrivate = r.source === 'private';
              return (
                <Card key={key} className="rounded-3xl border-0 shadow-sm bg-white">
                  <CardContent className="p-4">
                    <View className="flex flex-row items-center gap-2 mb-1">
                      <Text className="block text-base font-bold text-[#3E3226] flex-1">{r.name}</Text>
                      <Badge className={isPrivate ? 'bg-[#FF8C42] text-white border-0' : 'bg-[#FFF3E0] text-[#8B7D6E] border-0'}>
                        {isPrivate ? '我的' : (r.category || '家常菜')}
                      </Badge>
                    </View>
                    {r.brief ? <Text className="block text-xs text-[#8B7D6E] mb-2">{r.brief}</Text> : null}
                    <View className="flex flex-row flex-wrap gap-1.5 mb-2">
                      {r.duration_minutes ? (
                        <Badge variant="outline" className="bg-[#FFFDF8] border-[#F0E2D0] text-[#8B7D6E]">
                          <Clock size={12} color="#c76a2a" className="mr-1" />{r.duration_minutes}分
                        </Badge>
                      ) : null}
                      {r.difficulty ? (
                        <Badge variant="outline" className="bg-[#FFFDF8] border-[#F0E2D0] text-[#8B7D6E]">
                          <ChefHat size={12} color="#c76a2a" className="mr-1" />{r.difficulty}
                        </Badge>
                      ) : null}
                      {(r.flavors ?? []).map((f, fi) => (
                        <Badge key={fi} variant="outline" className="bg-[#FFF3E0] border-0 text-[#FF8C42]">{f}</Badge>
                      ))}
                    </View>
                    <Text className="block text-xs text-[#8B7D6E] mb-1">食材：{(r.ingredients ?? []).join('、') || '—'}</Text>

                    {open ? (
                      <View className="mt-2 space-y-1">
                        <Text className="block text-xs font-semibold text-[#3E3226]">做法：</Text>
                        {(r.main_steps ?? []).map((s, si) => (
                          <Text key={si} className="block text-xs text-[#5B5349]">{si + 1}. {s}</Text>
                        ))}
                      </View>
                    ) : null}

                    <View className="flex flex-row gap-2 mt-3">
                      <Button size="sm" variant="outline" className="flex-1 rounded-full border-[#F0E2D0] text-[#8B7D6E]" onClick={() => setExpanded(open ? null : key)}>
                        {open ? '收起做法' : '查看做法'}
                      </Button>
                      {isPrivate && r.id && (
                        <Button size="sm" variant="outline" className="rounded-full border-[#F44336] text-[#F44336]" onClick={() => deleteRecipe(r.id!)}>
                          <Trash2 size={14} color="#F44336" />
                        </Button>
                      )}
                    </View>
                  </CardContent>
                </Card>
              );
            })}
          </TabsContent>

          {/* 做菜历史 */}
          <TabsContent value="history" className="pt-4 space-y-3">
            {history.length === 0 && (
              <Text className="block text-center text-sm text-[#8B7D6E] py-10">还没有完成过做菜，去首页试试「今天吃什么」吧</Text>
            )}
            {history.map((h) => (
              <Card key={h.id} className="rounded-3xl border-0 shadow-sm bg-white overflow-hidden">
                <View className="bg-[#FF8C42] px-4 py-2 flex flex-row items-center justify-between">
                  <Text className="block text-xs font-bold text-white">{h.date}</Text>
                  <Text className="block text-xs text-orange-100">{h.diners_count} 人 · 已出餐 🎉</Text>
                </View>
                <CardContent className="p-4">
                  <Text className="block text-sm font-bold text-[#3E3226] mb-2">今日菜单</Text>
                  {(h.selected_dishes ?? []).map((d, i) => (
                    <View key={i} className="flex flex-row items-center gap-2 py-1">
                      <View className="w-2 h-2 rounded-full bg-[#FF8C42]" />
                      <Text className="block text-sm text-[#5B5349]">{d.name}</Text>
                    </View>
                  ))}
                </CardContent>
              </Card>
            ))}
          </TabsContent>
        </Tabs>
      </View>

      {/* 新建菜谱弹窗 */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="w-[90%] rounded-3xl">
          <DialogHeader>
            <DialogTitle>创建私人菜谱</DialogTitle>
          </DialogHeader>
          <Text className="block text-xs text-[#8B7D6E] mb-2">用一句话描述这道菜（AI 会自动提炼菜名、食材与步骤），或录音输入：</Text>
          <View className="bg-[#FFF3E0] rounded-2xl px-3 py-2">
            <Textarea
              placeholder="例如：烤箱版蒜香鸡翅，鸡翅用蒜和生抽腌制，200度烤20分钟，外焦里嫩"
              value={text}
              onInput={(e) => setText(e.detail.value)}
              className="w-full min-h-24"
            />
          </View>
          {isMiniApp ? (
            <Button variant={recording ? 'default' : 'outline'} className="rounded-full" onClick={startRecord} disabled={recording}>
              <Mic size={16} color={recording ? '#fff' : '#FF8C42'} className="mr-1" />
              {recording ? '录音中… 点击停止' : '语音录入（小程序）'}
            </Button>
          ) : (
            <Badge variant="outline" className="self-start bg-[#FFF3E0] border-0 text-[#8B7D6E]">
              <FileText size={12} color="#8B7D6E" className="mr-1" />语音仅微信小程序可用
            </Badge>
          )}
          <DialogFooter className="flex flex-row gap-2 pt-2">
            <Button variant="outline" className="flex-1 rounded-full border-[#F0E2D0] text-[#8B7D6E]" onClick={() => setCreateOpen(false)}>取消</Button>
            <Button className="flex-1 rounded-full bg-primary text-white" onClick={createRecipe} disabled={saving}>
              {saving ? '保存中…' : '保存菜谱'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </ScrollView>
  );
}