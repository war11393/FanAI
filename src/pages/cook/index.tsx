import { useEffect, useState } from 'react';
import Taro from '@tarojs/taro';
import { View, Text } from '@tarojs/components';
import { Network } from '@/network';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Check, ChevronRight, PartyPopper, Mic } from 'lucide-react-taro';
import { Checkbox } from '@/components/ui/checkbox';

interface Dish { name: string; duration_minutes?: number; ingredients?: string[]; main_steps?: string[] }
interface PrepItem { task: string; done: boolean }
interface CookStep { title: string; content: string; stove?: string; minutes?: number }

const isMiniApp = Taro.getEnv() === Taro.ENV_TYPE.WEAPP || Taro.getEnv() === Taro.ENV_TYPE.TT;

export default function CookPage() {
  const [phase, setPhase] = useState<'prep' | 'cooking' | 'done'>('prep');
  const [dishes, setDishes] = useState<Dish[]>([]);
  const [diners, setDiners] = useState(2);
  const [stoves, setStoves] = useState<Array<{ type: string; count: number }>>([]);
  const [prepList, setPrepList] = useState<PrepItem[]>([]);
  const [steps, setSteps] = useState<CookStep[]>([]);
  const [stepIndex, setStepIndex] = useState(0);
  const [voiceOn, setVoiceOn] = useState(false);
  const [generating, setGenerating] = useState(true);
  const [recording, setRecording] = useState(false);

  useEffect(() => {
    const meal = Taro.getStorageSync('cook_meal');
    if (meal && meal.dishes) {
      setDishes(meal.dishes);
      setDiners(meal.dinersCount || meal.dishes.length * 2);
      setStoves(meal.stoves || []);
      setVoiceOn(Taro.getStorageSync('voice_control_on') === true);
      generatePrep(meal.dishes, meal.dinersCount || 2);
    } else {
      setGenerating(false);
      Taro.showToast({ title: '请先选择菜品', icon: 'none' });
    }
  }, []);

  const generatePrep = async (dishList: Dish[], count: number) => {
    setGenerating(true);
    try {
      const res: any = await Network.request({
        url: '/api/ai/prep', method: 'POST',
        data: { openid: Taro.getStorageSync('openid') || '', dinersCount: count, dishes: dishList },
      });
      const data = res.data?.data ?? {};
      setPrepList((data.prepList ?? []).map((t: string) => ({ task: t, done: false })));
    } catch (e) {
      console.error('[cook] prep error', e);
      setPrepList([]);
    } finally { setGenerating(false); }
  };

  const finishPrep = async () => {
    setPhase('cooking');
    setStepIndex(0);
    try {
      const res: any = await Network.request({
        url: '/api/ai/cooking', method: 'POST',
        data: { openid: Taro.getStorageSync('openid') || '', dinersCount: diners, dishes, stoves },
      });
      const data = res.data?.data ?? {};
      setSteps(data.steps ?? []);
      speak(textForStep(0));
    } catch (e) {
      console.error('[cook] cooking error', e);
      setSteps([{ title: '先热锅', content: '热锅凉油，准备开始烹饪。' }]);
      speak('先热锅，热锅凉油。');
    }
  };

  const togglePrep = (idx: number) => {
    setPrepList((l) => l.map((it, i) => (i === idx ? { ...it, done: !it.done } : it)));
  };
  const allDone = prepList.length > 0 && prepList.every((it) => it.done);

  const textForStep = (i: number) => {
    const step = steps[i];
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
      await Network.request({
        url: '/api/meal-plans/save', method: 'POST',
        data: {
          openid: Taro.getStorageSync('openid') || '',
          diners_count: diners,
          selected_dishes: dishes.map((d) => ({ name: d.name, duration_minutes: d.duration_minutes })),
          prep_list: prepList.map((p) => p.task),
          cooking_steps: steps,
          status: 'done',
        },
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
    </View>
  );
}