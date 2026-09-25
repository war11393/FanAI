import { useEffect, useState, useCallback } from 'react';
import Taro from '@tarojs/taro';
import { View, Text, ScrollView } from '@tarojs/components';
import {
  listIngredients,
  aiParseText,
  aiRecognizePhoto,
  batchAddIngredients,
  removeIngredient as removeIngredientApi,
  uploadIngredientPhoto,
  type Ingredient,
} from '@/cloud/api';
import { remainingDays } from '@/utils/shelf-life';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Camera, Mic, PencilLine, Plus } from 'lucide-react-taro';

const STATUS_LABEL: Record<string, { text: string; color: string; chip: string }> = {
  fresh: { text: '新鲜', color: '#4CAF50', chip: 'bg-[#E8F5E9] text-[#4CAF50]' },
  expiring: { text: '临期', color: '#FFC107', chip: 'bg-[#FFF8E1] text-[#E6A700]' },
  expired: { text: '过期', color: '#F44336', chip: 'bg-[#FFEBEE] text-[#F44336]' },
};

export default function FridgePage() {
  const [list, setList] = useState<Ingredient[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<'all' | 'fresh' | 'expiring' | 'expired'>('all');
  const [fabOpen, setFabOpen] = useState(false);
  // 文本录入
  const [textOpen, setTextOpen] = useState(false);
  const [textVal, setTextVal] = useState('');
  const [saving, setSaving] = useState(false);
  // 语音
  const [recorder, setRecorder] = useState<Taro.RecorderManager | null>(null);
  const [recording, setRecording] = useState(false);
  const isMiniApp = Taro.getEnv() === Taro.ENV_TYPE.WEAPP || Taro.getEnv() === Taro.ENV_TYPE.TT;

  useEffect(() => {
    load();
  }, []);

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

  /** 拍照 -> 上传云存储 -> 视觉识别 -> 批量入库 */
  const handlePickPhoto = async () => {
    try {
      const res = await Taro.chooseImage({ count: 1 });
      const filePath = res.tempFilePaths[0];
      Taro.showLoading({ title: '识别中...' });
      // ★ 替代原 Network.uploadFile：先传云存储拿 fileID，再把 fileID 交给视觉模型
      const fileID = await uploadIngredientPhoto(filePath);
      const recognizeData = await aiRecognizePhoto(fileID);
      Taro.hideLoading();
      const items = recognizeData.items ?? [];
      if (items.length === 0) {
        Taro.showToast({ title: '未识别出食材，请换张清晰照片', icon: 'none' });
        return;
      }
      await batchAddIngredients(
        items.map((it) => ({
          name: it.name,
          quantity: it.quantity,
          unit: it.unit,
          shelfLifeDays: it.shelfLifeDays,
          source: 'photo' as const,
        })),
      );
      Taro.showToast({ title: `已录入 ${items.length} 种食材`, icon: 'success' });
      load();
    } catch (e) {
      Taro.hideLoading();
      console.error('[fridge] photo error', e);
      Taro.showToast({ title: '识别失败', icon: 'none' });
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
    try {
      const fileID = await uploadIngredientPhoto(filePath);
      const recognizeData = await aiRecognizePhoto(fileID);
      Taro.hideLoading();
      const items = recognizeData.items ?? [];
      if (items.length === 0) {
        Taro.showToast({ title: '未识别出食材，可改用文本输入', icon: 'none' });
        return;
      }
      await batchAddIngredients(
        items.map((it) => ({
          name: it.name,
          quantity: it.quantity,
          unit: it.unit,
          source: 'voice' as const,
        })),
      );
      Taro.showToast({ title: '语音录入成功', icon: 'success' });
      load();
    } catch (e) {
      Taro.hideLoading();
      console.error('[fridge] voice error', e);
      Taro.showToast({ title: '语音识别失败，请用文本录入', icon: 'none' });
    }
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
                          数量 {it.quantity} {it.unit} · {it.source === 'photo' ? '拍照' : it.source === 'voice' ? '语音' : '文本'}录入
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
    </View>
  );
}