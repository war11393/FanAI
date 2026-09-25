import { useEffect, useState } from 'react';
import Taro from '@tarojs/taro';
import { View, Text } from '@tarojs/components';
import {
  getUserProfile,
  listIngredients,
  aiRecommend,
  type UserProfile,
  type Ingredient,
  type AiDish,
} from '@/cloud/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Sparkles, UserPlus, RefreshCw, Check } from 'lucide-react-taro';

type Dish = AiDish;

export default function IndexPage() {
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [ingredients, setIngredients] = useState<Ingredient[]>([]);
  const [temporaryGuests, setTemporaryGuests] = useState(0);
  // 来且了弹窗
  const [guestOpen, setGuestOpen] = useState(false);
  const [guestCount, setGuestCount] = useState(0);
  // AI 推荐
  const [dishes, setDishes] = useState<Dish[]>([]);
  const [recommending, setRecommending] = useState(false);
  const [aiOffline, setAiOffline] = useState(false);
  // 多选
  const [selected, setSelected] = useState<string[]>([]);

  const loadHome = async () => {
    try {
      // ★ openid 由云函数从微信上下文获取，前端不再传
      const [profileData, ingredientData] = await Promise.all([
        getUserProfile(),
        listIngredients(),
      ]);
      setProfile(profileData ?? null);
      setIngredients(ingredientData.list ?? []);
    } catch (e) {
      console.error('[index] loadHome error', e);
    }
  };

  useEffect(() => { loadHome(); }, []);

  const regular = profile?.regularMembers ?? 2;
  const total = regular + temporaryGuests;
  const expiringCount = ingredients.filter((i) => i.status === 'expiring').length;
  const expiredCount = ingredients.filter((i) => i.status === 'expired').length;
  const alertCount = expiringCount + expiredCount;

  const handleRecommend = async (useGuests: number) => {
    setRecommending(true);
    setDishes([]);
    setSelected([]);
    Taro.showLoading({ title: 'AI 正在想今天的菜谱...' });
    try {
      const data = await aiRecommend({
        dinersCount: regular + useGuests,
        ingredients: ingredients.map((i) => i.name),
        stoves: profile?.stoves ?? [],
        allergies: profile?.allergies ?? [],
        taboos: profile?.taboos ?? [],
      });
      setDishes(data.dishes ?? []);
      setAiOffline(!!data.aiOffline);
      if (data.aiOffline) {
        Taro.showToast({ title: '智能推荐暂不可用，已展示备选菜谱', icon: 'none' });
      }
    } catch (e) {
      console.error('[index] recommend error', e);
      Taro.showToast({ title: '推荐失败，请重试', icon: 'none' });
    } finally {
      Taro.hideLoading();
      setRecommending(false);
    }
  };

  const onRecommendClick = () => {
    if (recommending) return;
    handleRecommend(temporaryGuests);
  };

  const onConfirmGuest = () => {
    setTemporaryGuests(guestCount);
    setGuestOpen(false);
  };

  const toggleDish = (name: string) => {
    setSelected((prev) => (prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name]));
  };

  const startCooking = () => {
    if (selected.length === 0) {
      Taro.showToast({ title: '请至少选择一道菜', icon: 'none' });
      return;
    }
    const selectedDishes = dishes.filter((d) => selected.includes(d.name));
    Taro.setStorageSync('cook_meal', {
      dinersCount: total,
      dishes: selectedDishes,
      stoves: profile?.stoves ?? [],
    });
    Taro.navigateTo({ url: '/pages/cook/index' });
  };

  return (
    <View className="min-h-screen bg-[#FAF3E7] pb-32">
      {/* 顶部人数区 */}
      <View className="px-5 pt-6">
        <Card className="bg-[#FF8C42] rounded-3xl border-none shadow-lg">
          <CardContent className="p-5">
            <View className="flex flex-row items-center justify-between">
              <View>
                <Text className="block text-3xl font-bold text-white">{total} 人</Text>
                <Text className="block text-sm mt-1 text-orange-50">
                  今日就餐{expiredCount > 0 ? '（含过期提醒）' : ''}
                </Text>
                {temporaryGuests > 0 && (
                  <View className="mt-2 flex flex-row">
                    <View className="bg-white rounded-full px-3 py-1">
                      <Text className="block text-xs font-medium text-[#FF8C42]">
                        {regular} 常驻 + {temporaryGuests} 临时来客
                      </Text>
                    </View>
                  </View>
                )}
              </View>
              <Button
                size="sm"
                className="bg-white text-[#FF8C42] rounded-full px-4 py-2 shadow"
                onClick={() => { setGuestCount(temporaryGuests); setGuestOpen(true); }}
              >
                <UserPlus size={16} color="#FF8C42" className="mr-1" />
                来且了 +
              </Button>
            </View>
          </CardContent>
        </Card>
      </View>

      {/* 中央大按钮 */}
      <View className="px-5 mt-8 flex flex-col items-center">
        <View className="w-full flex flex-col items-center justify-center rounded-[2.5rem] bg-white py-12 shadow-sm border border-orange-100" style={{ minHeight: 260 }}>
          <Text className="block text-5xl mb-4">🍳</Text>
          <Text className="block text-2xl font-bold text-gray-800 mb-2">今天吃什么？</Text>
          <Text className="block text-sm text-gray-400 text-center mb-6">
            {ingredients.length > 0 ? `冰箱有 ${ingredients.length} 种食材，让我来安排` : '冰箱空啦，推荐几道经典家常菜'}
          </Text>
          <Button
            className="bg-[#FF8C42] rounded-full px-10 py-3 text-white shadow-xl active:scale-95"
            disabled={recommending}
            onClick={onRecommendClick}
          >
            <Sparkles size={20} color="#fff" className="mr-2" />
            {recommending ? '思考中...' : '让 AI 帮我决定'}
          </Button>
        </View>
      </View>

      {/* 临期提醒 */}
      {alertCount > 0 && (
        <View className="px-5 mt-6">
          <Card className="bg-[#FFF3E0] border-[#FFD8A8] rounded-2xl">
            <CardContent className="p-4 flex flex-row items-center justify-between">
              <View>
                <Text className="block text-lg font-bold text-[#B26A00]">临期食材提醒</Text>
                <Text className="block text-sm text-[#8D6E63] mt-1">
                  {expiredCount > 0 ? `${expiredCount} 种过期 · ` : ''}{expiringCount} 种即将过期
                </Text>
              </View>
              <Button size="sm" variant="outline" className="text-[#B26A00]" onClick={() => Taro.switchTab({ url: '/pages/fridge/index' })}>
                去处理
              </Button>
            </CardContent>
          </Card>
        </View>
      )}

      {/* AI 推荐结果卡片 */}
      {(dishes.length > 0 || recommending) && (
        <View className="px-5 mt-6">
          <View className="flex flex-row items-center justify-between mb-3">
            <Text className="block text-lg font-bold text-gray-800">
              为你推荐
              {selected.length > 0 && <Text className="text-[#FF8C42]">（已选 {selected.length} 道）</Text>}
            </Text>
            <Button size="sm" variant="ghost" onClick={() => handleRecommend(temporaryGuests)}>
              <RefreshCw size={16} color="#FF8C42" />{' '}
              <Text className="ml-1 text-[#FF8C42]">换一批</Text>
            </Button>
          </View>
          {aiOffline && (
            <View className="bg-[#FFF8E1] rounded-lg px-3 py-2 mb-3">
              <Text className="block text-xs text-[#B26A00]">智能推荐服务暂不可用，为你展示保证可做的家常菜</Text>
            </View>
          )}
          <View className="flex flex-col gap-4">
            {dishes.map((dish, idx) => {
              const isSelected = selected.includes(dish.name);
              return (
                <Card
                  key={`${dish.name}-${idx}`}
                  className={`rounded-2xl border shadow-sm ${isSelected ? 'border-[#FF8C42] ring-2 ring-[#FFDDC2]' : 'border-gray-100'}`}
                >
                  <CardContent className="p-5">
                    <View className="flex flex-row items-center justify-between mb-2">
                      <View className="flex-1 flex flex-row items-center">
                        <Text className="block text-xl font-bold text-gray-800">{dish.name}</Text>
                        {dish.duration_minutes && (
                          <Text className="block text-sm text-[#FF8C42] font-medium ml-3">{dish.duration_minutes} 分钟</Text>
                        )}
                      </View>
                      {/* 多选指示 */}
                      <View
                        className={`w-7 h-7 rounded-full flex items-center justify-center border-2 ${isSelected ? 'bg-[#FF8C42] border-[#FF8C42]' : 'border-gray-300 bg-white'}`}
                      >
                        {isSelected && <Check size={16} color="#fff" />}
                      </View>
                    </View>
                    {dish.brief && <Text className="block text-sm text-gray-500 mb-2">{dish.brief}</Text>}
                    {dish.ingredients && dish.ingredients.length > 0 && (
                      <View className="flex flex-row flex-wrap gap-2 mb-3">
                        {dish.ingredients.map((ig) => (
                          <View key={ig} className="bg-[#FFF3E0] rounded-full px-3 py-1">
                            <Text className="block text-xs text-[#B26A00]">{ig}</Text>
                          </View>
                        ))}
                      </View>
                    )}
                    <Button
                      variant={isSelected ? 'default' : 'outline'}
                      className={`w-full rounded-full ${isSelected ? 'bg-[#FF8C42]' : ''}`}
                      onClick={() => toggleDish(dish.name)}
                    >
                      {isSelected ? '已选，点按取消' : '选择这道菜'}
                    </Button>
                  </CardContent>
                </Card>
              );
            })}
          </View>
        </View>
      )}

      {/* 底部操作栏（多选后进入做菜流程） */}
      {dishes.length > 0 && (
        <View
          className="border-t border-gray-200"
          style={{
            position: 'fixed', left: 0, right: 0, bottom: 50,
            display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 12,
            padding: '12px 16px', backgroundColor: '#fff', zIndex: 100,
          }}
        >
          <View style={{ flex: 1 }}>
            <Button
              disabled={selected.length === 0}
              className={`w-full rounded-full ${selected.length > 0 ? 'bg-[#FF8C42]' : ''}`}
              onClick={startCooking}
            >
              开始做菜{selected.length > 0 ? `（${selected.length} 道）` : '（先选菜）'}
            </Button>
          </View>
        </View>
      )}

      {/* 来且了弹窗 */}
      <Dialog open={guestOpen} onOpenChange={setGuestOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>今天家里来客啦 👋</DialogTitle>
          </DialogHeader>
          <View className="flex flex-col items-center py-2">
            <View className="text-5xl mb-4 animate-bounce">🏃‍♂️</View>
            <Text className="block text-sm text-gray-500 mb-4 text-center">临时加的人数只对本次推荐生效，不会改变家庭常驻设置</Text>
            <View className="flex flex-row items-center gap-6">
              <Button size="icon" variant="outline" className="rounded-full h-12 w-12" onClick={() => setGuestCount((c) => Math.max(0, c - 1))}>−</Button>
              <Text className="block text-4xl font-bold text-gray-800">{guestCount} 人</Text>
              <Button size="icon" variant="outline" className="rounded-full h-12 w-12" onClick={() => setGuestCount((c) => c + 1)}>＋</Button>
            </View>
          </View>
          <DialogFooter>
            <View className="flex flex-row gap-3 w-full">
              <Button variant="outline" className="flex-1" onClick={() => setGuestOpen(false)}>取消</Button>
              <Button className="flex-1 bg-[#FF8C42]" onClick={onConfirmGuest}>确定（共 {regular + guestCount} 人）</Button>
            </View>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </View>
  );
}