import { useEffect, useRef } from "react";
import { sloth } from "../../api";

// 页面本地数据的统一刷新入口：挂载时执行一次，deps 变化时执行一次，窗口重新聚焦时再执行一次。
// 多页面共享的数据应放进全局 store（onFocus 里统一刷新），单页面自用的数据用这个 Hook。
export function useFocusRefresh(refresh: () => void | Promise<void>, deps: unknown[] = []) {
  const ref = useRef(refresh);
  ref.current = refresh;

  useEffect(() => {
    void ref.current();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    if (!sloth) return;
    return sloth.app.onFocus(() => void ref.current());
  }, []);
}
