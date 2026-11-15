// 所有样式最先放进来,先后见 ui/styles.ts(宽屏、手机的布局在最后,盖过各处的默认样式)
import './ui/styles';
import { Component, useState, type CSSProperties, type ErrorInfo, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { scrubSecrets } from './ai/settings';
import { getDiag, setDiagScrubber } from './diag/log';
import { installDiagWatch } from './diag/watch';
import { Boot, bootHelper } from './ui/Boot';
import { galleryHelperMode } from './ui/homeStart';

/**
 * 界面渲染时抛错(首页、主程序都在内):给一张能自己恢复的回退页,别只剩白屏。
 * 三个恢复入口:重新加载、回「我的世界」、复制出错信息。
 */
class AppErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('界面出错', error, info.componentStack);
  }
  render() {
    return this.state.error ? <CrashFallback error={this.state.error} /> : this.props.children;
  }
}

const pageStyle: CSSProperties = {
  position: 'fixed', inset: 0, zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center',
  padding: 24, background: '#f5efe3', color: '#2c2620', font: '15px/1.7 system-ui, -apple-system, sans-serif',
};
const cardStyle: CSSProperties = {
  boxSizing: 'border-box', width: '100%', maxWidth: 460, padding: '28px 26px', borderRadius: 14,
  background: '#fffdf7', border: '1px solid #ddd2bb', boxShadow: '0 14px 44px rgba(40,30,15,.14)',
};
const btnBase: CSSProperties = { padding: '9px 15px', borderRadius: 8, border: '1px solid #c9bca3', background: '#fff', color: '#2c2620', fontSize: 14, cursor: 'pointer' };
const btnMain: CSSProperties = { ...btnBase, background: '#3b6d62', borderColor: '#3b6d62', color: '#fff' };

/** 回退页里的「查看问题记录」:直接读这台设备记下的日志,不依赖已经崩掉的那棵界面树 */
function diagText(): string {
  try {
    const recent = getDiag().entries.slice(-30);
    return recent.length ? JSON.stringify(recent, null, 2) : '还没有记到问题。';
  } catch {
    return '这一刻读不到问题记录，重新加载以后到「更多 → 问题记录」里看。';
  }
}

function CrashFallback({ error }: { error: Error }) {
  const [showLog, setShowLog] = useState(false);
  return (
    <div style={pageStyle} role="alert">
      <div style={cardStyle}>
        <h1 style={{ margin: '0 0 12px', fontSize: 20 }}>页面出了点问题</h1>
        <p style={{ margin: '0 0 8px', color: '#5b5346' }}>这一处没能显示出来。世界还在这个浏览器里，重新打开就能接着看。</p>
        <p style={{ margin: '0 0 20px', color: '#5b5346' }}>可以试下面三种办法：</p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
          <button style={btnMain} onClick={() => location.reload()}>重新加载</button>
          <button style={btnBase} onClick={() => location.assign(location.origin + location.pathname)}>回「我的世界」</button>
          <button style={btnBase} onClick={() => setShowLog((v) => !v)}>{showLog ? '收起问题记录' : '查看问题记录'}</button>
        </div>
        <pre style={{ margin: '18px 0 0', padding: 10, borderRadius: 8, background: '#f3ecdd', color: '#796a51', fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: 120, overflow: 'auto' }}>{error.message}</pre>
        {showLog && (
          <pre aria-label="问题记录" style={{ margin: '10px 0 0', padding: 10, borderRadius: 8, background: '#f3ecdd', color: '#796a51', fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: 220, overflow: 'auto' }}>
            {diagText()}
          </pre>
        )}
      </div>
    </div>
  );
}

if (galleryHelperMode()) {
  // 帮手模式(作品墙的后台在看不见的框里打开网站画封面、列名字):不出界面、不记问题记录(不往浏览器里存东西)
  bootHelper();
} else {
  // 问题记录:最先接上,启动时出的错也记得到
  setDiagScrubber(scrubSecrets);
  installDiagWatch();

  // 先出首页、主程序在后台下载;不是首页的直接下载主程序(Boot.tsx)
  createRoot(document.getElementById('root')!).render(
    <AppErrorBoundary>
      <Boot />
    </AppErrorBoundary>,
  );
}
