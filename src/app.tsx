import { PropsWithChildren } from 'react';
import { LucideTaroProvider } from 'lucide-react-taro';
import '@/app.css';
import { Toaster } from '@/components/ui/toast';
import { initCloud } from '@/cloud';
import { Preset } from './presets';

/**
 * 云开发环境初始化
 * ★ 必须在任何 Taro.cloud 调用之前执行，因此放在模块顶层（而非 useEffect）
 * ★ initCloud() 内部已做幂等与端判断，H5/抖音端会安全跳过
 */
initCloud();

const App = ({ children }: PropsWithChildren) => {
  return (
    <LucideTaroProvider defaultColor="#000" defaultSize={24}>
      <Preset>{children}</Preset>
      <Toaster />
    </LucideTaroProvider>
  );
};

export default App;
