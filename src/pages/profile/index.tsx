import { useCallback, useEffect, useState } from 'react';
import { View, Text, ScrollView } from '@tarojs/components';
import Taro from '@tarojs/taro';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Minus, Plus, UserRound, Refrigerator, ChefHat, AlarmSmoke } from 'lucide-react-taro';
import { getUserProfile, saveUserProfile, type UserProfile } from '@/cloud/api';
import { useProfileStore } from '@/store/profile';

const STOVE_OPTIONS = ['燃气灶', '电磁炉', '电陶炉', '烤箱', '空气炸锅'];
const POT_OPTIONS = ['炒锅', '汤锅', '平底锅', '蒸锅', '砂锅', '高压锅'];
const QUICK_ALLERGIES = ['花生', '海鲜', '乳制品', '鸡蛋', '坚果', '大豆'];
const QUICK_TABOOS = ['香菜', '葱', '大蒜', '内脏', '肥肉', '辣', '味精'];
const QUICK_FLAVORS = ['偏辣', '偏淡', '偏甜', '偏咸', '偏酸', '偏麻', '重口味', '清淡', '喜欢蒜香', '喜欢葱香', '开胃酸爽', '无辣不欢'];

const ProfilePage = () => {
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [allergyInput, setAllergyInput] = useState('');
  const [tabooInput, setTabooInput] = useState('');
  const [flavorInput, setFlavorInput] = useState('');
  const [saving, setSaving] = useState(false);
  // ★ C1：写入全局 store，供首页实时同步
  const setGlobalProfile = useProfileStore((s) => s.setProfile);

  const loadProfile = useCallback(async () => {
    try {
      const d = await getUserProfile();
      console.log('[profile] load:', d);
      setProfile(d ?? null);
    } catch (e) {
      console.error('[profile] load error', e);
    }
  }, []);

  useEffect(() => {
    loadProfile();
  }, [loadProfile]);

  const update = (patch: Partial<UserProfile>) => {
    setProfile((p) => (p ? { ...p, ...patch } : p));
  };

  const stepMembers = (delta: number) => {
    const base = profile?.regularMembers ?? 2;
    update({ regularMembers: Math.max(1, Math.min(10, base + delta)) });
  };

  const toggleInList = (key: 'allergies' | 'taboos' | 'flavors', value: string) => {
    const list = (profile?.[key] as string[]) ?? [];
    update({ [key]: list.includes(value) ? list.filter((i) => i !== value) : [...list, value] } as Partial<UserProfile>);
  };

  const addCustom = (key: 'allergies' | 'taboos' | 'flavors', value: string) => {
    const v = value.trim();
    if (!v) return;
    const list = (profile?.[key] as string[]) ?? [];
    if (!list.includes(v)) update({ [key]: [...list, v] } as Partial<UserProfile>);
    if (key === 'allergies') setAllergyInput('');
    else if (key === 'taboos') setTabooInput('');
    else setFlavorInput('');
  };

  const toggleStove = (type: string) => {
    const stoves = profile?.stoves ?? [];
    const idx = stoves.findIndex((s) => s.type === type);
    if (idx >= 0) {
      const next = stoves.filter((s) => s.type !== type);
      update({ stoves: next });
    } else {
      update({ stoves: [...stoves, { type, count: 1 }] });
    }
  };

  const stepStove = (type: string, delta: number) => {
    const stoves = profile?.stoves ?? [];
    const next = stoves
      .map((s) => (s.type === type ? { ...s, count: Math.max(0, s.count + delta) } : s))
      .filter((s) => s.count > 0);
    update({ stoves: next });
  };

  const togglePot = (pot: string) => {
    const pots = profile?.pots ?? [];
    update({ pots: pots.includes(pot) ? pots.filter((i) => i !== pot) : [...pots, pot] });
  };

  const save = async () => {
    if (!profile) return;
    setSaving(true);
    let toastMsg = '';
    try {
      const saved = await saveUserProfile({
        regularMembers: profile.regularMembers,
        stoves: profile.stoves,
        pots: profile.pots,
        allergies: profile.allergies,
        taboos: profile.taboos,
        flavors: profile.flavors,
        voiceControlOn: profile.voiceControlOn,
      });
      console.log('[profile] save res:', saved);
      setProfile(saved);
      // ★ C1：同步写入全局 store，首页无需重新拉取即可显示新人数
      setGlobalProfile(saved);
      // 语音开关单独持久化，供做菜阶段读取
      Taro.setStorageSync('voice_control_on', !!saved.voiceControlOn);
      toastMsg = '已保存';
    } catch (e) {
      console.error('[profile] save error', e);
      toastMsg = '保存失败，请稍后再试';
    } finally {
      setSaving(false);
      Taro.hideLoading();
      if (toastMsg) {
        Taro.showToast({
          title: toastMsg,
          icon: toastMsg === '已保存' ? 'success' : 'none',
        });
      }
    }
  };

  const SectionTitle = ({ icon, title }: { icon: React.ReactNode; title: string }) => (
    <View className="flex items-center gap-2 mb-3">
      <View className="w-2 h-2 rounded-full bg-primary" />
      {icon}
      <Text className="block text-base font-bold text-[#3E3226]">{title}</Text>
    </View>
  );

  if (!profile) {
    return (
      <View className="flex-1 items-center justify-center py-20">
        <Text className="block text-[#8B7D6E] text-sm">加载中…</Text>
      </View>
    );
  }

  return (
    <ScrollView scrollY className="bg-[#FFF3E0] w-full h-full">
      <View className="px-5 py-5 space-y-4 pb-32">
        {/* 常驻人数 */}
        <Card className="rounded-3xl border-0 shadow-sm bg-[#FFFDF8]">
          <CardContent className="p-5 space-y-4">
            <SectionTitle icon={<UserRound size={18} color="#FF8C42" />} title="家庭常驻人数" />
            <View className="flex items-center justify-between">
              <View className="flex items-center gap-1">
                <Badge className="bg-[#FFF3E0] text-[#3E3226] border-0">推荐 2-4 人</Badge>
              </View>
              <View className="flex flex-row items-center gap-4">
                <Button size="icon" variant="outline" className="rounded-full h-10 w-10 border-[#FF8C42] bg-[#FFF3E0]" onClick={() => stepMembers(-1)}>
                  <Minus size={18} color="#FF8C42" />
                </Button>
                <Text className="block text-2xl font-bold text-[#3E3226] w-6 text-center">{profile.regularMembers}</Text>
                <Button size="icon" variant="outline" className="rounded-full h-10 w-10 border-[#FF8C42] bg-[#FFF3E0]" onClick={() => stepMembers(1)}>
                  <Plus size={18} color="#FF8C42" />
                </Button>
              </View>
            </View>
          </CardContent>
        </Card>

        {/* 灶具锅具 */}
        <Card className="rounded-3xl border-0 shadow-sm bg-[#FFFDF8]">
          <CardContent className="p-5 space-y-4">
            <SectionTitle icon={<ChefHat size={18} color="#FF8C42" />} title="灶具与锅具" />
            <View>
              <Text className="block text-sm font-semibold text-[#3E3226] mb-2">灶具（我可同时使用）</Text>
              <View className="flex flex-row flex-wrap gap-2">
                {STOVE_OPTIONS.map((s) => {
                  const item = (profile.stoves ?? []).find((x) => x.type === s);
                  const active = !!item;
                  return active ? (
                    <View key={s} className="flex items-center gap-1 bg-primary rounded-full pl-3 pr-1 py-1">
                      <Text className="block text-xs font-semibold text-white">{s}</Text>
                      <View className="flex items-center">
                        <Button size="icon" className="h-6 w-6 rounded-full bg-white bg-opacity-20 text-white" onClick={() => stepStove(s, -1)}>
                          <Minus size={12} color="#fff" />
                        </Button>
                        <Text className="block text-xs font-bold text-white w-5 text-center">{item?.count ?? 0}</Text>
                        <Button size="icon" className="h-6 w-6 rounded-full bg-white bg-opacity-20 text-white" onClick={() => stepStove(s, 1)}>
                          <Plus size={12} color="#fff" />
                        </Button>
                      </View>
                    </View>
                  ) : (
                    <Badge key={s} variant="outline" className="cursor-pointer bg-[#FFF3E0] border-[#F0E2D0] text-[#3E3226]" onClick={() => toggleStove(s)}>
                      + {s}
                    </Badge>
                  );
                })}
              </View>
            </View>
            <View>
              <Text className="block text-sm font-semibold text-[#3E3226] mb-2">锅具</Text>
              <View className="flex flex-row flex-wrap gap-2">
                {POT_OPTIONS.map((p) => {
                  const active = (profile.pots ?? []).includes(p);
                  return (
                    <Badge
                      key={p}
                      variant={active ? 'default' : 'outline'}
                      className={active ? 'cursor-pointer bg-primary text-white border-0' : 'cursor-pointer bg-[#FFF3E0] border-[#F0E2D0] text-[#3E3226]'}
                      onClick={() => togglePot(p)}
                    >
                      {active ? '✓ ' : '+ '}{p}
                    </Badge>
                  );
                })}
              </View>
            </View>
          </CardContent>
        </Card>

        {/* 饮食偏好 */}
        <Card className="rounded-3xl border-0 shadow-sm bg-[#FFFDF8]">
          <CardContent className="p-5 space-y-4">
            <SectionTitle icon={<Refrigerator size={18} color="#FF8C42" />} title="饮食偏好" />
            <View>
              <Text className="block text-sm font-semibold text-[#3E3226] mb-2">过敏史</Text>
              <View className="flex flex-row flex-wrap gap-2 mb-2">
                {QUICK_ALLERGIES.map((a) => {
                  const active = (profile.allergies ?? []).includes(a);
                  return (
                    <Badge key={a} variant={active ? 'default' : 'outline'} className={active ? 'cursor-pointer bg-[#F44336] text-white border-0' : 'cursor-pointer bg-[#FFF3E0] border-[#F0E2D0] text-[#3E3226]'} onClick={() => toggleInList('allergies', a)}>
                      {active ? '✓ ' : '+ '}{a}
                    </Badge>
                  );
                })}
              </View>
              <View className="flex flex-row gap-2 items-center">
                <View className="flex-1">
                  <Input placeholder="自定义过敏原（如：芒果）" value={allergyInput} onInput={(e) => setAllergyInput(e.detail.value)} />
                </View>
                <Button size="sm" onClick={() => addCustom('allergies', allergyInput)}>添加</Button>
              </View>
            </View>
            <View>
              <Text className="block text-sm font-semibold text-[#3E3226] mb-2">饮食禁忌</Text>
              <View className="flex flex-row flex-wrap gap-2 mb-2">
                {QUICK_TABOOS.map((t) => {
                  const active = (profile.taboos ?? []).includes(t);
                  return (
                    <Badge key={t} variant={active ? 'default' : 'outline'} className={active ? 'cursor-pointer bg-[#FFC107] text-white border-0' : 'cursor-pointer bg-[#FFF3E0] border-[#F0E2D0] text-[#3E3226]'} onClick={() => toggleInList('taboos', t)}>
                      {active ? '✓ ' : '+ '}{t}
                    </Badge>
                  );
                })}
              </View>
              <View className="flex flex-row gap-2 items-center">
                <View className="flex-1">
                  <Input placeholder="自定义禁忌（如：不吃苦瓜）" value={tabooInput} onInput={(e) => setTabooInput(e.detail.value)} />
                </View>
                <Button size="sm" onClick={() => addCustom('taboos', tabooInput)}>添加</Button>
              </View>
            </View>
            <View>
              <Text className="block text-sm font-semibold text-[#3E3226] mb-2">口味偏好</Text>
              <Text className="block text-xs text-[#8B7D6E] mb-2">AI 推荐会更贴合你的的口味（可多选）</Text>
              <View className="flex flex-row flex-wrap gap-2 mb-2">
                {QUICK_FLAVORS.map((f) => {
                  const active = (profile.flavors ?? []).includes(f);
                  return (
                    <Badge key={f} variant={active ? 'default' : 'outline'} className={active ? 'cursor-pointer bg-primary text-white border-0' : 'cursor-pointer bg-[#FFF3E0] border-[#F0E2D0] text-[#3E3226]'} onClick={() => toggleInList('flavors', f)}>
                      {active ? '✓ ' : '+ '}{f}
                    </Badge>
                  );
                })}
              </View>
              <View className="flex flex-row gap-2 items-center">
                <View className="flex-1">
                  <Input placeholder="自定义口味（如：喜欢麻酱）" value={flavorInput} onInput={(e) => setFlavorInput(e.detail.value)} />
                </View>
                <Button size="sm" onClick={() => addCustom('flavors', flavorInput)}>添加</Button>
              </View>
            </View>
          </CardContent>
        </Card>

        {/* 语音控制 */}
        <Card className="rounded-3xl border-0 shadow-sm bg-[#FFFDF8]">
          <CardContent className="p-5 flex items-center justify-between">
            <View className="flex items-center gap-3">
              <AlarmSmoke size={20} color="#FF8C42" />
              <View>
                <Text className="block text-base font-bold text-[#3E3226]">语音控制</Text>
                <Text className="block text-xs text-[#8B7D6E]">做菜时语音喊&ldquo;下一步&rdquo;并自动播报（小程序端）</Text>
              </View>
            </View>
            <Switch checked={!!profile.voiceControlOn} onCheckedChange={(v) => update({ voiceControlOn: v })} />
          </CardContent>
        </Card>

        {/* 保存 */}
        <View className="pt-2">
          <Button className="w-full rounded-3xl h-12 text-base font-bold" onClick={save} disabled={saving}>
            {saving ? '保存中…' : '保存设置'}
          </Button>
        </View>
      </View>
    </ScrollView>
  );
};

export default ProfilePage;