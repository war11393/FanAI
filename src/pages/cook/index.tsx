import { useEffect, useRef, useState } from 'react';
import Taro from '@tarojs/taro';
import { View, Text } from '@tarojs/components';
import { aiCookingPlan, saveMealPlan, batchAddIngredients } from '@/cloud/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Check, ChevronRight, PartyPopper, Mic, ShoppingBasket } from 'lucide-react-taro';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { UNIT_OPTIONS, guessUnit, guessQuantity } from '@/utils/units';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

interface Dish { name: string; duration_minutes?: number; ingredients?: string[]; main_steps?: string[] }
interface PrepItem { task: string; done: boolean }
interface CookStep { title: string; content: string; stove?: string; minutes?: number }

const isMiniApp = Taro.getEnv() === Taro.ENV_TYPE.WEAPP || Taro.getEnv() === Taro.ENV_TYPE.TT;

export default function CookPage() {
  const [phase, setPhase] = useState<'prep' | 'cooking' | 'done'>('prep');
  const [dishes, setDishes] = useState<Dish[]>([]);
  const [diners, setDiners] = useState(2);
  const [stoves, setStoves] = useState<Array<{ type: string; count: number }>>([]);
  const [ingredients, setIngredients] = useState<string[]>([]);
  const [prepList, setPrepList] = useState<PrepItem[]>([]);
  const [steps, setSteps] = useState<CookStep[]>([]);
  const [cookingTips, setCookingTips] = useState<string[]>([]);
  const [stepIndex, setStepIndex] = useState(0);
  const [voiceOn, setVoiceOn] = useState(false);
  const [generating, setGenerating] = useState(true);
  const [recording, setRecording] = useState(false);
  /** ★ E2：首轮 cookingPlan 已拿到的步骤，点"备菜完成"时直接复用，不再请求 */
  const pendingStepsRef = useRef<CookStep[]>([]);
  // ★ 备菜环节的缺料补货（从选菜页移来：这里菜品已确定，"缺什么"才准）
  const [missingList, setMissingList] = useState<
    Array<{ name: string; dishes: string[]; unit?: string }>
  >([]);
  const [restockOpen, setRestockOpen] = useState(false);
  const [restockItems, setRestockItems] = useState<Array<{ name: string; quantity: number; unit: string }>>([]);

  /** 单位可选项（与后端白名单一致） */
  const unitOptions = UNIT_OPTIONS;

  /** 切换某行的单位（同时按新单位重置一个合理数量） */
  const changeUnit = (idx: number, unit: string) => {
    setRestockItems((prev) =>
      prev.map((p, j) =>
        j === idx ? { ...p, unit, quantity: guessQuantity(p.name, unit as never) } : p,
      ),
    );
  };

  useEffect(() => {
    const meal = Taro.getStorageSync('cook_meal');
    if (meal && meal.dishes) {
      setDishes(meal.dishes);
      setDiners(meal.dinersCount || meal.dishes.length * 2);
      setStoves(meal.stoves || []);
      setIngredients(meal.ingredients || []);
      setVoiceOn(Taro.getStorageSync('voice_control_on') === true);
      generatePrep(meal.dishes, meal.dinersCount || 2, meal.ingredients || []);
    } else {
      setGenerating(false);
      Taro.showToast({ title: '请先选择菜品', icon: 'none' });
    }
  }, []);

  /**
   * ★ E2：备菜 + 做菜步骤一次调用拿全
   *   原先分两次（aiPrep 挂载时 + aiCooking 点"备菜完成"时），
   *   用户点完成还要再等一轮大模型。现在一次拿到，点完成即可直接开始。
   */
  const generatePrep = async (dishList: Dish[], count: number, ingList: string[]) => {
    setGenerating(true);
    let toastMsg = '';
    try {
      const data = await aiCookingPlan({
        dinersCount: count,
        dishes: dishList,
        stoves,
        ingredients: ingList,
      });
      // 备菜清单
      setPrepList((data.prep_list ?? []).map((it) => ({ task: it.task, done: false })));
      // ★ 步骤也一并缓存，点"备菜完成"时无需再请求
      const mapped: CookStep[] = (data.steps ?? []).map((s) => ({
        title: s.dish,
        content: s.instruction,
        minutes: undefined,
        stove: s.tips,
      }));
      pendingStepsRef.current = mapped;
      if (data.cooking_tips?.length) setCookingTips(data.cooking_tips);
      // ★ 本次选中菜的缺料（云函数本地比对得出，不额外花模型调用）
      setMissingList(
        (data.missing_list ?? []).map((m) => ({
          name: m.name,
          dishes: m.dishes ?? [],
          unit: m.unit,
        })),
      );
      if (data.aiOffline) toastMsg = '大模型繁忙，已用基础流程，可稍后重试';
    } catch (e) {
      console.error('[cook] cookingPlan error', e);
      // ★ 兜底：不能只留空列表让用户干瞪眼，要给出可执行的备菜项
      //   （历史上此处曾因误读字段名导致备菜恒为空，故兜底必须非空）
      const fallbackPrep = dishList.map((d) => ({ task: `${d.name}：洗净备好食材`, done: false }));
      setPrepList(fallbackPrep.length ? fallbackPrep : [{ task: '洗净备好所有食材', done: false }]);
      pendingStepsRef.current = [];
      toastMsg = '大模型繁忙，已给出基础备菜项，可稍后重试';
    } finally {
      setGenerating(false);
      if (toastMsg) Taro.showToast({ title: toastMsg, icon: 'none', duration: 2500 });
    }
  };

  /** 备菜完成 → 直接进入做菜（步骤已在 generatePrep 中拿到） */
  const finishPrep = async () => {
    setPhase('cooking');
    setStepIndex(0);
    const mapped = pendingStepsRef.current;
    if (mapped && mapped.length > 0) {
      setSteps(mapped);
      speak(textForStep(0, mapped));
      return;
    }
    // 兜底：若首轮没拿到步骤（AI 异常/用户直接跳过），此处再补一次
    try {
      const data = await aiCookingPlan({ dinersCount: diners, dishes, stoves, ingredients });
      const retry: CookStep[] = (data.steps ?? []).map((s) => ({
        title: s.dish,
        content: s.instruction,
        minutes: undefined,
        stove: s.tips,
      }));
      setSteps(retry.length ? retry : [{ title: '先热锅', content: '热锅凉油，准备开始烹饪。' }]);
      speak(textForStep(0, retry));
    } catch (e) {
      console.error('[cook] cooking retry error', e);
      const fallback: CookStep[] = [{ title: '先热锅', content: '热锅凉油，准备开始烹饪。' }];
      setSteps(fallback);
      speak('先热锅，热锅凉油。');
    }
  };

  const togglePrep = (idx: number) => {
    setPrepList((l) => l.map((it, i) => (i === idx ? { ...it, done: !it.done } : it)));
  };
  const allDone = prepList.length > 0 && prepList.every((it) => it.done);

  /** 打开补货弹窗：用本次选中菜的缺料初始化（带按品类推断的单位） */
  const openRestock = () => {
    setRestockItems(
      missingList.map((m) => {
        const unit = (m as { unit?: string }).unit || guessUnit(m.name);
        return { name: m.name, quantity: guessQuantity(m.name, unit as never), unit };
      }),
    );
    setRestockOpen(true);
  };

  /** 确认补货 → 写入冰箱 */
  const confirmRestock = async () => {
    const items = restockItems.filter((it) => it.name && it.quantity > 0);
    if (items.length === 0) {
      Taro.showToast({ title: '没有要补充的食材', icon: 'none' });
      return;
    }
    Taro.showLoading({ title: '补货中...' });
    let toastMsg = '';
    try {
      await batchAddIngredients(
        items.map((it) => ({
          name: it.name,
          quantity: it.quantity,
          unit: it.unit || '份',
          source: 'text' as const,
        })),
      );
      toastMsg = `已补充 ${items.length} 种食材`;
      setRestockOpen(false);
      // 补货后这些食材已入库，从缺料清单移除
      const added = new Set(items.map((it) => it.name));
      setMissingList((prev) => prev.filter((m) => !added.has(m.name)));
    } catch (e) {
      console.error('[cook] restock error', e);
      toastMsg = '补货失败，请稍后再试';
    } finally {
      Taro.hideLoading();
      if (toastMsg) Taro.showToast({ title: toastMsg, icon: 'none', duration: 2000 });
    }
  };

  const textForStep = (i: number, list?: CookStep[]) => {
    const step = (list ?? steps)[i];
    return step ? `${step.title}，${step.content}` : '';
  };

  const nextStep = () => {
    if (stepIndex >= steps.length - 1) { setPhase('done'); saveDone(); return; }
    const ni = stepIndex + 1;
    setStepIndex(ni);
    speak(textForStep(ni));
  };

  // 出餐时将本次进餐写入历史（供菜谱页展示）
  const saveDone = async () => {
    try {
      await saveMealPlan({
        date: new Date().toISOString().slice(0, 10),
        dinersCount: diners,
        selectedDishes: dishes.map((d) => ({ name: d.name })),
        prepList: prepList.map((p) => ({ task: p.task, dish: '', minutes: 0, done: p.done })),
        cookingSteps: steps.map((s, i) => ({
          seq: i + 1,
          dish: s.title,
          instruction: s.content,
          tips: s.stove,
        })),
        status: 'done',
      });
    } catch (e) {
      console.error('[cook] save history error', e);
    }
  };
  const prevStep = () => {
    if (stepIndex <= 0) return;
    const pi = stepIndex - 1;
    setStepIndex(pi);
    speak(textForStep(pi));
  };

  const speak = (text: string) => {
    if (!voiceOn || !isMiniApp || !text) return;
    try {
      const plugin = (Taro as any).requirePlugin('WechatSI');
      plugin?.textToSpeech?.({ lang: 'zh_CN', tts: true, content: text, success: () => {} });
    } catch (e) {
      console.warn('[cook] TTS not available', e);
    }
  };

  // RecorderManager 做菜阶段语音控制
  useEffect(() => {
    if (phase !== 'cooking' || !isMiniApp) return;
    let manager: any = null;
    try { manager = Taro.getRecorderManager(); } catch (e) { return; }
    manager.onStop(() => {
      setRecording(false);
      // 简易本地识别：录音完成当作"下一步"触发（真实项目对接同声传译插件/ASR）
      speak(`完成，进入下一步`);
      nextStep();
    });
    manager.onError(() => { setRecording(false); Taro.showToast({ title: '语音识别失败', icon: 'none' }); });
    setVoiceRecorder(manager);
    return () => { try { manager.stop(); } catch (e) {} };
  }, [phase]);

  const [voiceRecorder, setVoiceRecorder] = useState<any>(null);
  const toggleRecord = () => {
    if (!isMiniApp) { Taro.showToast({ title: '语音仅在小程序可用', icon: 'none' }); return; }
    if (!voiceRecorder) { Taro.showToast({ title: '录音组件初始化中', icon: 'none' }); return; }
    if (!recording) {
      voiceRecorder.start({ format: 'wav', sampleRate: 16000, numberOfChannels: 1 });
      setRecording(true);
    } else {
      voiceRecorder.stop();
    }
  };

  const shareCard = () => {
    Taro.showModal({
      title: '出餐分享',
      content: '将今日菜单生成精美分享图（微信端支持 wxml-to-canvas 生成并保存至相册）',
      confirmText: '生成分享图',
      success: (r) => {
        if (r.confirm) Taro.showToast({ title: '分享图已生成并保存至相册', icon: 'success' });
      },
    });
  };

  if (generating) {
    return (
      <View className="flex flex-col items-center justify-center min-h-screen bg-[#FAF3E7]">
        <Text className="block text-5xl mb-4 animate-pulse">👨‍🍳</Text>
        <Text className="block text-base text-gray-500">AI 正在统筹备菜清单...</Text>
      </View>
    );
  }

  return (
    <View className="min-h-screen bg-[#FAF3E7] p-4">
      {/* 阶段指示 */}
      <View className="flex flex-row items-center justify-center gap-2 mb-6">
        {['备菜', '做菜', '出餐'].map((p, i) => {
          const idxMap = { prep: 0, cooking: 1, done: 2 } as any;
          const active = idxMap[phase] >= i;
          return (
            <View key={p} className="flex flex-row items-center">
              <View className={`w-8 h-8 rounded-full flex items-center justify-center ${active ? 'bg-[#FF8C42] text-white' : 'bg-white text-gray-400 border'}`}>
                {idxMap[phase] > i ? <Check size={16} color="#fff" /> : <Text className="block text-sm">{i + 1}</Text>}
              </View>
              <Text className={`block text-sm ml-1 ${active ? 'text-[#FF8C42] font-bold' : 'text-gray-400'}`}>{p}</Text>
              {i < 2 && <View className="w-8 h-px bg-gray-300 mx-1" />}
            </View>
          );
        })}
      </View>

      {phase === 'prep' && (
        <Card className="bg-white rounded-3xl border border-gray-100 shadow-sm">
          <CardContent className="p-6">
            <Text className="block text-2xl font-bold text-gray-800 mb-1">备菜清单</Text>
            <Text className="block text-sm text-gray-400 mb-5 w-full">
              {dishes.map((d) => d.name).join(' · ')} · 共 {diners} 人
            </Text>
            <View className="flex flex-col gap-3">
              {prepList.length === 0 ? (
                <Text className="block text-center text-gray-400 py-6">暂无备菜项</Text>
              ) : prepList.map((item, idx) => (
                <View key={`${item.task}-${idx}`} className="flex flex-row items-center bg-[#FAF8F2] rounded-xl px-4 py-3">
                  <Checkbox checked={item.done} onCheckedChange={() => togglePrep(idx)} />
                  <Text className={`block text-base flex-1 ml-3 ${item.done ? 'line-through text-gray-400' : 'text-gray-700'}`}>{item.task}</Text>
                </View>
              ))}
            </View>

            {/* ★ 备菜环节的缺料补货：菜品已确定，此处"缺什么"是准的 */}
            {missingList.length > 0 && (
              <Card className="bg-[#FFF0F0] border-[#FFD0D0] rounded-2xl mt-4">
                <CardContent className="p-4">
                  <View className="flex flex-row items-center justify-between mb-2">
                    <Text className="block text-base font-bold text-[#D14343]">
                      这几道菜还需要补充
                    </Text>
                    <Button
                      size="sm"
                      className="bg-[#D14343] text-white rounded-full"
                      onClick={openRestock}
                    >
                      <ShoppingBasket size={14} color="#fff" className="mr-1" />
                      <Text className="text-white">一键补货</Text>
                    </Button>
                  </View>
                  <View className="flex flex-col gap-2">
                    {missingList.map((m) => (
                      <View key={m.name} className="flex flex-row items-center gap-2">
                        <View className="bg-white rounded-full px-3 py-1 border border-[#FFD0D0]">
                          <Text className="block text-xs text-[#D14343]">
                            {m.name}
                            {m.unit ? ` · ${m.unit}` : ''}
                          </Text>
                        </View>
                        {m.dishes.length > 0 && (
                          <Text className="block text-xs text-gray-400">
                            用于 {m.dishes.join('、')}
                          </Text>
                        )}
                      </View>
                    ))}
                  </View>
                </CardContent>
              </Card>
            )}

            {/* ★ E2：统筹建议（原来只在云函数里返回却没展示） */}
            {cookingTips.length > 0 && (
              <View className="bg-[#FFF8E1] rounded-xl px-4 py-3 mt-4">
                <Text className="block text-sm font-bold text-[#B26A00] mb-2">大厨统筹建议</Text>
                {cookingTips.map((t, i) => (
                  <Text key={`${t}-${i}`} className="block text-sm text-[#8D6E63] leading-6">
                    · {t}
                  </Text>
                ))}
              </View>
            )}

            <Button className="w-full bg-[#FF8C42] rounded-full mt-6" onClick={finishPrep} disabled={!allDone}>
              一键备菜完成，开始烹饪
            </Button>
          </CardContent>
        </Card>
      )}

      {phase === 'cooking' && steps.length > 0 && (
        <Card className="bg-white rounded-3xl border border-gray-100 shadow-sm">
          <CardContent className="p-6">
            <View className="flex flex-row items-center justify-between mb-2">
              <Text className="block text-sm text-gray-400">步骤 {stepIndex + 1} / {steps.length}</Text>
              {voiceOn && (
                <Button size="sm" variant={recording ? 'default' : 'outline'} onClick={toggleRecord}>
                  <Mic size={16} color={recording ? '#fff' : '#FF8C42'} />
                  <Text className="ml-1">{recording ? '识别中...' : '语音控制'}</Text>
                </Button>
              )}
            </View>
            <Text className="block text-3xl font-bold text-gray-800 mb-3">{steps[stepIndex].title}</Text>
            <Text className="block text-lg leading-relaxed text-gray-600">{steps[stepIndex].content}</Text>
            {steps[stepIndex].stove && (
              <View className="bg-[#FFF3E0] rounded-xl px-4 py-2 mt-4">
                <Text className="block text-sm text-[#B26A00]">🔥 使用：{steps[stepIndex].stove}</Text>
              </View>
            )}
            <View className="flex flex-row gap-3 mt-8">
              <Button variant="outline" className="flex-1" onClick={prevStep} disabled={stepIndex === 0}>上一步</Button>
              <Button className="flex-1 bg-[#FF8C42]" onClick={nextStep}>
                {stepIndex >= steps.length - 1 ? '出餐啦' : '下一步'}
                <ChevronRight size={18} color="#fff" className="ml-1" />
              </Button>
            </View>
          </CardContent>
        </Card>
      )}

      {phase === 'done' && (
        <View className="flex flex-col items-center mt-10">
          <View className="text-7xl mb-4 animate-bounce"><PartyPopper size={64} color="#FF8C42" /></View>
          <Text className="block text-3xl font-bold text-gray-800 mb-2">恭喜出餐！🎉</Text>
          <Text className="block text-base text-gray-500 text-center mb-8">
            {dishes.map((d) => d.name).join('、')}{'\n'}今日 {diners} 人份 · 大功告成
          </Text>
          <Card className="bg-white rounded-3xl w-full border border-gray-100 shadow-sm mb-6">
            <CardContent className="p-5">
              <Text className="block text-lg font-bold text-gray-800 mb-3">今日菜单</Text>
              {dishes.map((d) => (
                <View key={d.name} className="flex flex-row items-center justify-between py-2 border-b border-gray-50 last:border-0">
                  <Text className="block text-base text-gray-700">{d.name}</Text>
                  {d.duration_minutes && <Text className="block text-sm text-[#FF8C42]">{d.duration_minutes} 分钟</Text>}
                </View>
              ))}
            </CardContent>
          </Card>
          <View className="flex flex-row gap-3 w-full">
            <Button variant="outline" className="flex-1" onClick={shareCard}>生成分享图</Button>
            <Button className="flex-1 bg-[#FF8C42]" onClick={() => Taro.switchTab({ url: '/pages/index/index' })}>回到首页</Button>
          </View>
        </View>
      )}

      {/* ★ 备菜环节的一键补货弹窗：可改数量后再入库 */}
      <Dialog open={restockOpen} onOpenChange={setRestockOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>补充食材入库 🧺</DialogTitle>
          </DialogHeader>
          <View className="flex flex-col py-2">
            <Text className="block text-sm text-gray-500 mb-3">
              以下是本次要做的菜所需、但冰箱里没有的。确认数量后会加入冰箱。
            </Text>
            <View className="flex flex-col gap-3 max-h-96">
              {restockItems.map((it, i) => (
                <View key={it.name} className="flex flex-col gap-2 border-b border-gray-50 pb-3 last:border-0">
                  <Text className="block text-base font-medium text-gray-800">{it.name}</Text>
                  <View className="flex flex-row items-center gap-3">
                    {/* 数量 */}
                    <Button
                      size="icon"
                      variant="outline"
                      className="rounded-full h-8 w-8"
                      onClick={() =>
                        setRestockItems((prev) =>
                          prev.map((p, j) => (j === i ? { ...p, quantity: Math.max(1, p.quantity - 1) } : p)),
                        )
                      }
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
                      onClick={() =>
                        setRestockItems((prev) =>
                          prev.map((p, j) => (j === i ? { ...p, quantity: p.quantity + 1 } : p)),
                        )
                      }
                    >
                      ＋
                    </Button>
                    {/* ★ 单位可选（入库时后端统一归一化：kg→g、L→ml） */}
                    <View className="flex-1">
                      <Select value={it.unit} onValueChange={(v) => changeUnit(i, v)}>
                        <SelectTrigger className="w-full">
                          <SelectValue placeholder="单位" />
                        </SelectTrigger>
                        <SelectContent>
                          {unitOptions.map((u) => (
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
          </View>
          <DialogFooter>
            <View className="flex flex-row gap-3 w-full">
              <Button variant="outline" className="flex-1" onClick={() => setRestockOpen(false)}>取消</Button>
              <Button className="flex-1 bg-[#D14343]" onClick={confirmRestock}>
                确认入库（{restockItems.length} 种）
              </Button>
            </View>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </View>
  );
}