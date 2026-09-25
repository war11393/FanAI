import { useEffect, useState, useCallback } from 'react';
import Taro, { useDidShow } from '@tarojs/taro';
import { View, Text, ScrollView } from '@tarojs/components';
import {
  listIngredients,
  aiParseText,
  aiRecognizePhoto,
  batchAddIngredients,
  removeIngredient as removeIngredientApi,
  type Ingredient,
} from '@/cloud/api';
import { readImageAsDataUrl } from '@/cloud';
import { remainingDays } from '@/utils/shelf-life';
import { UNIT_OPTIONS, guessUnit, guessQuantity } from '@/utils/units';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Camera, Mic, PencilLine, Plus, Trash2 } from 'lucide-react-taro';

const STATUS_LABEL: Record<string, { text: string; color: string; chip: string }> = {
  fresh: { text: '新鲜', color: '#4CAF50', chip: 'bg-[#E8F5E9] text-[#4CAF50]' },
  expiring: { text: '临期', color: '#FFC107', chip: 'bg-[#FFF8E1] text-[#E6A700]' },
  expired: { text: '过期', color: '#F44336', chip: 'bg-[#FFEBEE] text-[#F44336]' },
};

/**
 * 录入途径的可读文案
 * ★ 同类项合并后 source 可能是「text+photo」这种组合（例如先文本录入"番茄"、
 *   后拍照录入"西红柿"，两条合并为一条），需按组合展示而非只认单值。
 */
const SOURCE_LABEL: Record<string, string> = {
  text: '文本',
  photo: '拍照',
  voice: '语音',
};

function formatSource(source?: string): string {
  if (!source) return '文本';
  const parts = String(source).split('+').filter(Boolean);
  if (parts.length === 0) return '文本';
  return parts.map((p) => SOURCE_LABEL[p] || '文本').join('+');
}

/** ★ 拍照识别后的待确认项（用户可改名称/数量/单位，或删除） */
interface ReviewItem {
  name: string;
  quantity: number;
  unit: string;
  shelfLifeDays?: number;
}

export default function FridgePage() {
  const [list, setList] = useState<Ingredient[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<'all' | 'fresh' | 'expiring' | 'expired'>('all');
  const [fabOpen, setFabOpen] = useState(false);
  // 文本录入
  const [textOpen, setTextOpen] = useState(false);
  const [textVal, setTextVal] = useState('');
  const [saving, setSaving] = useState(false);
  // ★ 拍照识别的确认弹窗（F1：识别后先确认再入库）
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewItems, setReviewItems] = useState<ReviewItem[]>([]);
  const [reviewSource, setReviewSource] = useState<'photo' | 'voice'>('photo');
  // 语音
  const [recorder, setRecorder] = useState<Taro.RecorderManager | null>(null);
  const [recording, setRecording] = useState(false);
  const isMiniApp = Taro.getEnv() === Taro.ENV_TYPE.WEAPP || Taro.getEnv() === Taro.ENV_TYPE.TT;

  useEffect(() => {
    load();
  }, []);

  /**
   * ★ tab 页切回来时刷新
   *   此前只在挂载时 load：从做菜页「一键补货」写入冰箱后切到冰箱页，
   *   数据其实已入库，但页面还是旧列表 —— 必须重新进小程序才看得到。
   *   useDidShow 覆盖"切 tab 回来"这一路径。
   */
  useDidShow(() => {
    load();
  });

  // 录音初始化（仅小程序）
  useEffect(() => {
    if (isMiniApp) {
      const manager = Taro.getRecorderManager();
      manager.onStart(() => setRecording(true));
      manager.onStop((res) => {
        setRecording(false);
        if (res.tempFilePath) parseVoice(res.tempFilePath);
      });
      manager.onError(() => {
        setRecording(false);
        Taro.showToast({ title: '录音失败', icon: 'none' });
      });
      setRecorder(manager);
    }
  }, [isMiniApp]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // ★ openid 由云函数从微信上下文获取
      const data = await listIngredients();
      setList(data.list ?? []);
    } catch (e) {
      console.error('[fridge] load error', e);
    } finally {
      setLoading(false);
    }
  }, []);

  const visible = filter === 'all' ? list : list.filter((it) => it.status === filter);

  const handleTextSubmit = async () => {
    if (!textVal.trim()) return;
    setSaving(true);
    try {
      // 先调用 AI 解析（失败会返回本地兜底）
      const parseData = await aiParseText(textVal);
      const items = parseData.items ?? [];
      if (items.length === 0) {
        Taro.showToast({ title: '未能识别食材，请描述更清晰', icon: 'none' });
        return;
      }
      await batchAddIngredients(
        items.map((it) => ({
          name: it.name,
          quantity: it.quantity,
          unit: it.unit,
          source: 'text' as const,
        })),
      );
      Taro.showToast({ title: `已录入 ${items.length} 种食材`, icon: 'success' });
      setTextVal('');
      setTextOpen(false);
      load();
    } catch (e) {
      console.error('[fridge] text submit error', e);
      Taro.showToast({ title: '录入失败', icon: 'none' });
    } finally {
      setSaving(false);
    }
  };

  /** 打开确认弹窗（识别结果作为初值，用户可增删改） */
  const openReview = (source: 'photo' | 'voice', items: ReviewItem[]) => {
    setReviewSource(source);
    setReviewItems(items);
    setReviewOpen(true);
  };

  /** 弹窗内：改数量 */
  const bumpReviewQty = (idx: number, delta: number) => {
    setReviewItems((prev) =>
      prev.map((p, j) => (j === idx ? { ...p, quantity: Math.max(1, p.quantity + delta) } : p)),
    );
  };

  /** 弹窗内：改单位（同步给一个合理数量） */
  const changeReviewUnit = (idx: number, unit: string) => {
    setReviewItems((prev) =>
      prev.map((p, j) =>
        j === idx ? { ...p, unit, quantity: guessQuantity(p.name, unit as never) } : p,
      ),
    );
  };

  /** 弹窗内：改名称 */
  const changeReviewName = (idx: number, name: string) => {
    setReviewItems((prev) => prev.map((p, j) => (j === idx ? { ...p, name } : p)));
  };

  /** 弹窗内：删除某项（识别错了） */
  const removeReviewItem = (idx: number) => {
    setReviewItems((prev) => prev.filter((_, j) => j !== idx));
  };

  /** 弹窗内：手动新增一项（识别漏了 / 识别失败时的兜底 F3） */
  const addReviewItem = () => {
    setReviewItems((prev) => [...prev, { name: '', quantity: 1, unit: '份' }]);
  };

  /** ★ 确认入库：校验名称非空后写入 */
  const confirmReview = async () => {
    const items = reviewItems.filter((it) => it.name && it.name.trim());
    if (items.length === 0) {
      Taro.showToast({ title: '请至少填写一种食材', icon: 'none' });
      return;
    }
    Taro.showLoading({ title: '入库中...' });
    let toastMsg = '';
    try {
      const res = await batchAddIngredients(
        items.map((it) => ({
          name: it.name.trim(),
          quantity: it.quantity,
          unit: it.unit,
          shelfLifeDays: it.shelfLifeDays,
          source: reviewSource,
        })),
      );
      // ★ 后端会做同类项合并，把"合并了几条"如实告诉用户
      const merged = (res as { merged?: number })?.merged ?? 0;
      toastMsg =
        merged > 0
          ? `已入库 ${items.length} 种（${merged} 种与冰箱已有食材合并）`
          : `已录入 ${items.length} 种食材`;
      setReviewOpen(false);
      load();
    } catch (e) {
      console.error('[fridge] review confirm error', e);
      toastMsg = '入库失败，请稍后再试';
    } finally {
      Taro.hideLoading();
      if (toastMsg) Taro.showToast({ title: toastMsg, icon: 'none', duration: 2500 });
    }
  };

  /**
   * 拍照 → base64 直传视觉模型 → **弹窗确认** → 入库
   * ---------------------------------------------------------------
   * ★ F1：此前识别完直接入库，用户没有机会核对/修正。
   * ★ F2：图片不落云存储，base64 直传，调用后即销毁。
   * ★ F3：识别失败/条数少时，允许用户手动补充后再确认。
   */
  const handlePickPhoto = async () => {
    try {
      const res = await Taro.chooseImage({ count: 1 });
      const filePath = res.tempFilePaths[0];
      Taro.showLoading({ title: '识别中...' });

      let toastMsg = '';
      let items: ReviewItem[] = [];
      try {
        // ★ F2：base64 直传，不经过云存储
        const dataUrl = await readImageAsDataUrl(filePath);
        const recognizeData = await aiRecognizePhoto(dataUrl);
        items = (recognizeData.items ?? []).map((it) => ({
          name: it.name,
          quantity: it.quantity ?? 1,
          unit: it.unit || guessUnit(it.name),
          shelfLifeDays: it.shelfLifeDays ?? 3,
        }));
        // 识别失败时：不阻断，进弹窗让用户手动添加（F3）
        if (items.length === 0) {
          toastMsg = '未识别出食材，可手动添加后入库';
        }
      } catch (e) {
        console.error('[fridge] photo recognize error', e);
        toastMsg = '识别失败，可手动添加后入库';
      } finally {
        Taro.hideLoading();
      }

      openReview('photo', items);
      if (toastMsg) Taro.showToast({ title: toastMsg, icon: 'none', duration: 2500 });
    } catch (e) {
      console.error('[fridge] photo error', e);
    }
  };

  /**
   * 语音录入
   * ★ 本环境未接入微信同声传译（需企业主体开通插件），
   *   因此语音文件同样走视觉模型的「识别」通道做兜底。
   *   完整语音转文字方案见 app.config.ts 中 plugins 的预留位说明。
   */
  const parseVoice = async (filePath: string) => {
    Taro.showLoading({ title: '识别中...' });
    let toastMsg = '';
    let items: ReviewItem[] = [];
    try {
      // 语音走视觉通道兜底：同样 base64 直传，不落云存储
      const dataUrl = await readImageAsDataUrl(filePath);
      const recognizeData = await aiRecognizePhoto(dataUrl);
      items = (recognizeData.items ?? []).map((it) => ({
        name: it.name,
        quantity: it.quantity ?? 1,
        unit: it.unit || guessUnit(it.name),
        shelfLifeDays: it.shelfLifeDays ?? 3,
      }));
      if (items.length === 0) toastMsg = '未识别出食材，可手动添加或改用文本输入';
    } catch (e) {
      console.error('[fridge] voice recognize error', e);
      toastMsg = '识别失败，可手动添加或改用文本输入';
    } finally {
      Taro.hideLoading();
    }
    // ★ 同样进确认弹窗，用户核对后再入库
    openReview('voice', items);
    if (toastMsg) Taro.showToast({ title: toastMsg, icon: 'none', duration: 2500 });
  };

  const startRecord = () => {
    if (!isMiniApp) {
      Taro.showToast({ title: 'H5端暂不支持录音，可用文本输入', icon: 'none' });
      return;
    }
    recorder?.start({ format: 'wav', sampleRate: 16000, numberOfChannels: 1 });
  };
  const stopRecord = () => recorder?.stop();

  const handleRemoveIngredient = async (id: string) => {
    const ok = await Taro.showModal({ title: '提示', content: '确定要删除该食材吗？', confirmText: '删除' });
    if (!ok.confirm) return;
    try {
      await removeIngredientApi(id);
      load();
    } catch (e) {
      console.error(e);
    }
  };

  return (
    <View className="min-h-screen bg-[#FAF3E7] pb-28">
      {/* 顶部标题 + 筛选 */}
      <View className="px-5 pt-6 pb-2">
        <Text className="block text-2xl font-bold text-gray-800">我的冰箱</Text>
        <Text className="block text-sm text-gray-500 mt-1">及时盘点，告别临期浪费</Text>
        <View className="flex flex-row gap-2 mt-4">
          {(['all', 'fresh', 'expiring', 'expired'] as const).map((k) => {
            const label = k === 'all' ? '全部' : STATUS_LABEL[k].text;
            const active = filter === k;
            const colorMap: Record<string, string> = {
              all: active ? 'bg-gray-800 text-white' : 'bg-white text-gray-500',
              fresh: active ? 'bg-[#4CAF50] text-white' : 'bg-white text-gray-500',
              expiring: active ? 'bg-[#FFC107] text-white' : 'bg-white text-gray-500',
              expired: active ? 'bg-[#F44336] text-white' : 'bg-white text-gray-500',
            };
            return (
              <Button key={k} size="sm" variant="outline" className={`rounded-full px-4 ${colorMap[k]}`} onClick={() => setFilter(k)}>
                {label}
              </Button>
            );
          })}
        </View>
      </View>

      {/* 食材列表 */}
      <ScrollView scrollY className="h-full">
        <View className="px-5">
          {loading ? (
            <View className="py-16 text-center">
              <Text className="block text-gray-400">加载中...</Text>
            </View>
          ) : visible.length === 0 ? (
            <View className="py-16 text-center">
              <Text className="block text-3xl mb-2">🧊</Text>
              <Text className="block text-gray-500">{filter === 'all' ? '冰箱空空如也，点右下角添加食材吧' : '该分类暂无食材'}</Text>
            </View>
          ) : (
            visible.map((it) => {
              const st = STATUS_LABEL[it.status] || STATUS_LABEL.fresh;
              const days = remainingDays(it.expireTime);
              return (
                <Card key={it._id} className="mb-3 bg-white rounded-2xl border border-gray-100 shadow-sm">
                  <CardContent className="p-4">
                    <View className="flex flex-row items-center justify-between">
                      <View className="flex-1">
                        <View className="flex flex-row items-center gap-2">
                          <Text className="block text-lg font-semibold text-gray-800">{it.name}</Text>
                          <Badge className={`${st.chip} border-0`}>{st.text}</Badge>
                        </View>
                        <Text className="block text-sm text-gray-500 mt-1">
                          数量 {it.quantity} {it.unit} · {formatSource(it.source)}录入
                        </Text>
                        <Text className={`block text-xs mt-1 ${days < 0 ? 'text-[#F44336]' : days <= 1 ? 'text-[#E6A700]' : 'text-gray-400'}`}>
                          {days < 0 ? `已过期 ${-days} 天` : days === 0 ? '今天到期' : `剩余 ${days} 天`}
                        </Text>
                      </View>
                      <View className="ml-3">
                        <Button size="sm" variant="ghost" onClick={() => handleRemoveIngredient(it._id)}>
                          <Text className="text-gray-400">删除</Text>
                        </Button>
                      </View>
                    </View>
                  </CardContent>
                </Card>
              );
            })
          )}
        </View>
      </ScrollView>

      {/* FAB 悬浮按钮 */}
      {fabOpen && (
        <View
          className="fixed inset-0"
          style={{ backgroundColor: 'rgba(0,0,0,0.3)', zIndex: 40 }}
          onClick={() => setFabOpen(false)}
        />
      )}
      <View className="fixed right-4 bottom-24 flex flex-col items-end gap-3" style={{ zIndex: 50 }}>
        {fabOpen && (
          <>
            <View className="flex flex-row items-center gap-3">
              <View className="bg-white rounded-full px-4 py-2 shadow-lg">
                <Text className="block text-sm text-gray-700">拍照识别</Text>
              </View>
              <Button size="icon" className="rounded-full bg-[#FF8C42] shadow-lg h-12 w-12" onClick={handlePickPhoto}>
                <Camera size={22} color="#fff" />
              </Button>
            </View>
            <View className="flex flex-row items-center gap-3">
              <View className="bg-white rounded-full px-4 py-2 shadow-lg">
                <Text className="block text-sm text-gray-700">{isMiniApp ? '语音输入' : '语音仅小程序'}</Text>
              </View>
              <Button size="icon" className="rounded-full bg-[#FFB74D] shadow-lg h-12 w-12" onClick={recording ? stopRecord : startRecord}>
                <Mic size={22} color="#fff" />
              </Button>
            </View>
            <View className="flex flex-row items-center gap-3">
              <View className="bg-white rounded-full px-4 py-2 shadow-lg">
                <Text className="block text-sm text-gray-700">手动文本</Text>
              </View>
              <Button size="icon" className="rounded-full bg-[#FFA726] shadow-lg h-12 w-12" onClick={() => { setTextOpen(true); setFabOpen(false); }}>
                <PencilLine size={22} color="#fff" />
              </Button>
            </View>
          </>
        )}
        <Button
          size="icon"
          className="rounded-full bg-[#FF8C42] shadow-xl h-14 w-14"
          onClick={() => setFabOpen((v) => !v)}
        >
          <Plus size={26} color="#fff" />
        </Button>
      </View>

      {/* 文本录入弹窗 */}
      <Dialog open={textOpen} onOpenChange={setTextOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>录入食材</DialogTitle>
          </DialogHeader>
          <View className="bg-gray-50 rounded-xl px-4 py-3">
            <Input
              className="w-full bg-transparent"
              placeholder="例如：两个西红柿、半斤五花肉、一盒鸡蛋"
              value={textVal}
              onInput={(e) => setTextVal(e.detail.value)}
            />
          </View>
          <View className="bg-[#FFF3E0] rounded-lg px-3 py-2">
            <Text className="block text-xs text-[#B26A00]">小提示：语音识别在小程序端可用；H5 端请使用文本录入。</Text>
          </View>
          <DialogFooter>
            <View className="flex flex-row gap-3 w-full">
              <Button variant="outline" className="flex-1" onClick={() => setTextOpen(false)}>取消</Button>
              <Button className="flex-1 bg-[#FF8C42]" disabled={saving} onClick={handleTextSubmit}>
                {saving ? '识别中...' : '识别录入'}
              </Button>
            </View>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/*
        ★ F1：拍照/语音识别的**确认弹窗**
        识别结果只是"初稿"，用户核对/修正后才入库 —— 避免识别错了直接污染冰箱。
        可改名称、数量、单位，可删除误识别项，也可手动补一项（F3 兜底）。
      */}
      <Dialog open={reviewOpen} onOpenChange={setReviewOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>确认食材 🧺</DialogTitle>
          </DialogHeader>
          <View className="flex flex-col py-2">
            <Text className="block text-sm text-gray-500 mb-3">
              以下是识别结果，请核对后入库。可以修改名称、数量与单位。
            </Text>

            {reviewItems.length === 0 ? (
              <Text className="block text-center text-gray-400 py-6">
                暂无识别结果，可点下方「手动添加一项」
              </Text>
            ) : (
              <View className="flex flex-col gap-3 max-h-96">
                {reviewItems.map((it, i) => (
                  <View key={`${it.name}-${i}`} className="flex flex-col gap-2 border-b border-gray-50 pb-3 last:border-0">
                    <View className="flex flex-row items-center gap-2">
                      {/* 名称可编辑 */}
                      <View className="flex-1 bg-gray-50 rounded-xl px-3 py-2">
                        <Input
                          className="w-full bg-transparent"
                          placeholder="食材名称"
                          value={it.name}
                          onInput={(e) => changeReviewName(i, e.detail.value)}
                        />
                      </View>
                      <Button
                        size="icon"
                        variant="outline"
                        className="rounded-full h-8 w-8"
                        onClick={() => removeReviewItem(i)}
                      >
                        <Trash2 size={14} color="#F44336" />
                      </Button>
                    </View>
                    <View className="flex flex-row items-center gap-3">
                      <Button
                        size="icon"
                        variant="outline"
                        className="rounded-full h-8 w-8"
                        onClick={() => bumpReviewQty(i, -1)}
                      >
                        −
                      </Button>
                      <Text className="block text-base font-bold text-gray-800 w-16 text-center">
                        {it.quantity}
                      </Text>
                      <Button
                        size="icon"
                        variant="outline"
                        className="rounded-full h-8 w-8"
                        onClick={() => bumpReviewQty(i, 1)}
                      >
                        ＋
                      </Button>
                      {/* 单位可选（入库时后端归一化） */}
                      <View className="flex-1">
                        <Select value={it.unit} onValueChange={(v) => changeReviewUnit(i, v)}>
                          <SelectTrigger className="w-full">
                            <SelectValue placeholder="单位" />
                          </SelectTrigger>
                          <SelectContent>
                            {UNIT_OPTIONS.map((u) => (
                              <SelectItem key={u} value={u}>
                                {u}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </View>
                    </View>
                  </View>
                ))}
              </View>
            )}

            <Button variant="outline" className="w-full mt-3" onClick={addReviewItem}>
              <Plus size={16} color="#FF8C42" className="mr-1" />
              手动添加一项
            </Button>
          </View>
          <DialogFooter>
            <View className="flex flex-row gap-3 w-full">
              <Button variant="outline" className="flex-1" onClick={() => setReviewOpen(false)}>取消</Button>
              <Button className="flex-1 bg-[#FF8C42]" onClick={confirmReview}>
                确认入库（{reviewItems.filter((it) => it.name && it.name.trim()).length} 种）
              </Button>
            </View>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </View>
  );
}