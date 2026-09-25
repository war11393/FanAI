import { useEffect, useState } from 'react';
import Taro, { useDidShow, useDidHide } from '@tarojs/taro';
import { View, Text } from '@tarojs/components';
import {
  getUserProfile,
  listIngredients,
  aiRecommend,
  listRecentDishes,
  matchRecipesByIngredients,
  type Ingredient,
  type AiDish,
} from '@/cloud/api';
import { useProfileStore } from '@/store/profile';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Sparkles, UserPlus, RefreshCw, Check } from 'lucide-react-taro';

type Dish = AiDish;

export default function IndexPage() {
  // ★ C1：人数等档案走全局 store（profile 页保存后实时同步）
  const profile = useProfileStore((s) => s.profile);
  const syncProfile = useProfileStore((s) => s.syncProfile);
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

  // ★ 布局说明（勿改回绝对定位）：
  //   本页是 tab 页，Taro/微信渲染层里页面可视区**已经排除了原生 TabBar**，
  //   因此 `position: fixed; bottom: 0` 天然就落在 TabBar 上沿，
  //   不需要任何 px 偏移量。此前用 bottom:50 / 动态算高度都是画蛇添足，
  //   且 screenHeight-windowHeight 含状态栏，会导致按钮偏高。
  //   安全区（全面屏底部横条）由 CSS env() 处理，同样不写死像素。

  /** 拉取食材（档案由 store 负责，避免重复请求） */
  const loadIngredients = async () => {
    try {
      const ingredientData = await listIngredients();
      setIngredients(ingredientData.list ?? []);
    } catch (e) {
      console.error('[index] loadIngredients error', e);
    }
  };

  /** 首次挂载：静默同步档案 + 拉食材 */
  useEffect(() => {
    syncProfile(getUserProfile);
    loadIngredients();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * ★ C1 兜底：tab 页切回来时静默重拉
   *   - 档案走 syncProfile（失败沿用全局旧值，不打断）
   *   - 食材直接刷新（临期状态可能已变化）
   */
  useDidShow(() => {
    syncProfile(getUserProfile);
    loadIngredients();
  });

  const regular = profile?.regularMembers ?? 2;
  const total = regular + temporaryGuests;
  const expiringCount = ingredients.filter((i) => i.status === 'expiring').length;
  const expiredCount = ingredients.filter((i) => i.status === 'expired').length;
  const alertCount = expiringCount + expiredCount;

  /**
   * ★ 缺料汇总（仅供提示，不再承载补货入口）
   *   补货已移到做菜页的备菜环节：那里菜品已确定，"缺什么"才是准的。
   */
  const hasMissing = dishes.some((d) => (d.missing_ingredients ?? []).length > 0);

  const handleRecommend = async (useGuests: number) => {
    setRecommending(true);
    setDishes([]);
    setSelected([]);
    Taro.showLoading({ title: 'AI 正在想今天的菜谱...' });
    // ★ C2：用变量记录待提示文案，在 hideLoading **之后**再 showToast，
    //   否则 showToast 会顶掉 loading、导致 hideLoading 报"未配对使用"
    let toastMsg = '';
    try {
      // ★ D2：先取近一周做过的菜（避开重复）；有食材时再取菜谱库候选（D1）
      const ingNames = ingredients.map((i) => i.name);
      const [recent, hints] = await Promise.all([
        listRecentDishes(7).catch((e) => {
          // 历史记录拉取失败不应阻断推荐
          console.warn('[index] 近一周记录获取失败，推荐将不避开重复', e);
          return { dishes: [] as string[] };
        }),
        ingNames.length > 0
          ? matchRecipesByIngredients(ingNames, 12).catch((e) => {
              console.warn('[index] 菜谱库匹配失败，推荐将不参考库内菜谱', e);
              return { list: [] as Array<{ name: string }> };
            })
          : Promise.resolve({ list: [] as Array<{ name: string }> }),
      ]);

      const recipeHints = (hints.list ?? []).map((r) => r.name);

      const data = await aiRecommend({
        dinersCount: regular + useGuests,
        ingredients: ingNames,
        stoves: profile?.stoves ?? [],
        allergies: profile?.allergies ?? [],
        taboos: profile?.taboos ?? [],
        flavors: profile?.flavors ?? [],
        recentDishes: recent.dishes ?? [],
        recipeHints,
      });
      setDishes(data.dishes ?? []);
      setAiOffline(!!data.aiOffline);
      if (data.aiOffline) toastMsg = '智能推荐暂不可用，已展示备选菜谱';
    } catch (e) {
      // ★ B3 兜底：调用异常时明确提示「大模型繁忙」，并建议稍后再试
      console.error('[index] recommend error', e);
      toastMsg = '大模型繁忙，请稍后再试';
    } finally {
      Taro.hideLoading();
      setRecommending(false);
      if (toastMsg) Taro.showToast({ title: toastMsg, icon: 'none', duration: 2500 });
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
      // ★ E1：把现有食材名一并带过去，备菜/做菜环节能标出缺料
      ingredients: ingredients.map((i) => i.name),
    });
    Taro.navigateTo({ url: '/pages/cook/index' });
  };

  /** 重置推荐结果与选择（离开首页时调用） */
  const resetRecommendState = () => {
    setDishes([]);
    setSelected([]);
    setAiOffline(false);
    setTemporaryGuests(0);
  };

  /**
   * ★ 离开首页时清空推荐结果
   *   本页是 tab 页不会卸载，状态会一直留着 —— 出餐回到首页会看到
   *   上一轮的菜和选中项。useDidHide 在切走/跳转时触发，正好清干净。
   */
  useDidHide(() => {
    resetRecommendState();
  });

  return (
    // ★ 根容器用 flex 纵向布局：让底部操作栏参与文档流（见下方 sticky 栏说明），
    //   不写死高度/位置，适配各种竖屏比例
    <View className="min-h-screen bg-[#FAF3E7] flex flex-col">
      {/* 主内容区：flex-1 撑满剩余空间，底部栏自然被推到底部 */}
      <View className="flex-1">
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

          {/* ★ 选菜阶段只做提示，不放补货入口：
              此时还没确定最终选哪几道菜，算不出"为这桌菜到底缺什么"。
              补货入口移到做菜页的备菜环节（那里菜品已确定）。 */}
          {hasMissing && (
            <View className="bg-[#FFF8E1] rounded-xl px-4 py-3 mb-4">
              <Text className="block text-sm text-[#B26A00]">
                部分菜需额外食材（已在下面对应菜上标出）。选好菜进入备菜环节可一键补货。
              </Text>
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
                        {dish.ingredients.map((ig) => {
                          // ★ D3：缺料在菜卡片内就地标出，信息就近
                          const missing = (dish.missing_ingredients ?? []).includes(ig);
                          return (
                            <View
                              key={ig}
                              className={`rounded-full px-3 py-1 ${missing ? 'bg-[#FFE0E0]' : 'bg-[#FFF3E0]'}`}
                            >
                              <Text className={`block text-xs ${missing ? 'text-[#D14343]' : 'text-[#B26A00]'}`}>
                                {missing ? `缺 ${ig}` : ig}
                              </Text>
                            </View>
                          );
                        })}
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

      </View>
      {/* ↑ 主内容区结束 */}

      {/*
        ★ 底部操作栏（多选后进入做菜流程）—— 纯流式，零绝对定位

        为什么这样写（前几轮踩坑的结论）：
        - 本页是 tab 页，页面可视区**已排除原生 TabBar**，所以任何 `bottom: N px`
          的偏移都是多余的；写死值必然在别的机型/屏幕比例上错位。
        - 这里改为**参与文档流**：内容区 `flex-1` 撑开，本栏自然被推到底部；
          菜品多时它位于全部菜品之后（随滚动可见），不会被压住、也不遮内容。
        - 安全区（全面屏底部条）交给 `env(safe-area-inset-bottom)`，不写死像素。
        - 因此**不需要占位块**——占位块正是绝对定位的补丁。
      */}
      {dishes.length > 0 && (
        <View
          className="bg-white border-t border-gray-200 px-4 pt-3 z-50"
          style={{ paddingBottom: 'calc(12px + env(safe-area-inset-bottom))' }}
        >
          <Button
            disabled={selected.length === 0}
            className={`w-full rounded-full ${selected.length > 0 ? 'bg-[#FF8C42]' : ''}`}
            onClick={startCooking}
          >
            开始做菜{selected.length > 0 ? `（${selected.length} 道）` : '（先选菜）'}
          </Button>
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