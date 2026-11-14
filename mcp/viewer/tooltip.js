/* 统一浮窗(地区/地块/魔力浓度共用):跟随鼠标、避让、拖动时自动隐藏。
 * 普通 <script>(IIFE),全局名 CivTooltip;不写样式表(样式在 style.css),不生成内容。
 *
 * 用法(app.js 负责内容):
 *   CivTooltip.init({
 *     map: canvas,                       // 定位基准,同时是事件源
 *     tip: document.getElementById('mapTip'),
 *     getHtml(cx, cy) {                  // cx,cy = 相对 canvas 左上角的 CSS 像素
 *       return '<div class="map-tip-card">…</div>'; // 返回 null / '' 表示此处无内容 → 隐藏
 *     },
 *     avoidRight() { return 260; },      // 可选:右侧被面板盖住的像素宽度
 *     margin: 10,                        // 可选:距 canvas 边缘的最小留白
 *   });
 *   CivTooltip.update();                 // 内容/数据变化后强制按最近坐标重刷
 *   CivTooltip.hide(); CivTooltip.destroy();
 *
 * 设计:
 *   - pointermove 只记坐标并排一帧 requestAnimationFrame,每帧最多调一次 getHtml;
 *   - 内容字符串没变就不重写 innerHTML(每次 pointermove 重建 DOM 会把 hover 卡死);
 *   - 用 transform translate 定位(不写 left/top,避免触发布局抖动);
 *   - 先显示再量 offsetWidth/Height(display:none 量不到),同一帧内再改 translate,不会闪;
 *   - pointerdown→pointerup 视为拖动/点击,期间隐藏(拖动平移时浮窗别乱跳)。
 */
(function () {
  'use strict';

  const OFF_X = 16;      // 光标右侧间距
  const OFF_Y = 18;      // 光标下方间距
  const DEF_MARGIN = 10; // 距 canvas 边缘最小留白

  // 老环境/Node fake DOM 兜底:没有 requestAnimationFrame 就用定时器(时间戳参数与 rAF 一致)
  const raf = typeof requestAnimationFrame === 'function'
    ? function (cb) { return requestAnimationFrame(cb); }
    : function (cb) { return setTimeout(function () { cb(Date.now()); }, 16); };
  const caf = typeof cancelAnimationFrame === 'function'
    ? function (id) { cancelAnimationFrame(id); }
    : function (id) { clearTimeout(id); };

  /** 当前实例(单例):重复 init 会先销毁旧实例,避免监听器叠加 */
  let current = null;

  function init(opts) {
    const o = opts || {};
    const map = o.map;
    const tip = o.tip;
    if (!map || !tip) throw new Error('CivTooltip.init:opts.map 与 opts.tip 必填');
    if (current) current.destroy();

    const getHtml = typeof o.getHtml === 'function' ? o.getHtml : null;
    const avoidRight = typeof o.avoidRight === 'function' ? o.avoidRight : null;
    const margin = typeof o.margin === 'number' && isFinite(o.margin) ? o.margin : DEF_MARGIN;

    let alive = true;
    let dragging = false;   // pointerdown 后到 pointerup 之间 = 拖动/点击,浮窗隐藏
    let px = 0, py = 0;     // 最近一次 pointermove 的 clientX/clientY(视口坐标)
    let hasPoint = false;   // 指针是否还在 canvas 上(pointerleave 后为 false)
    let frame = 0;          // 已排队的 rAF id,0 = 空闲
    let lastHtml = null;    // 上一次写入的内容,用来跳过重复 innerHTML
    let tipW = 0, tipH = 0; // 最近一次量到的浮窗尺寸
    let shown = false;      // 当前是否显示

    function hide() {
      if (frame) { caf(frame); frame = 0; }
      lastHtml = null;
      tipW = 0;
      tipH = 0;
      if (tip.innerHTML !== '') tip.innerHTML = '';
      if (tip.classList) tip.classList.add('hidden');
      shown = false;
    }

    /** 按最近 client 坐标渲染一帧:算 canvas 相对坐标 → 取内容 → 显示/隐藏 → 定位 */
    function render() {
      if (!alive) return;
      if (dragging || !hasPoint) { hide(); return; }

      const rect = typeof map.getBoundingClientRect === 'function' ? map.getBoundingClientRect() : null;
      const left = rect ? rect.left : 0;
      const top = rect ? rect.top : 0;
      const cw = map.clientWidth || (rect ? rect.width : 0) || 0;
      const ch = map.clientHeight || (rect ? rect.height : 0) || 0;
      const cx = px - left;
      const cy = py - top;

      let html = null;
      if (getHtml) {
        try { html = getHtml(cx, cy); } catch (err) { html = null; }
      }
      if (typeof html !== 'string' || html === '') { hide(); return; }

      const changed = html !== lastHtml;
      if (changed) { lastHtml = html; tip.innerHTML = html; }
      if (changed || !shown) {
        // 从 display:none 放出来再量,否则 offsetWidth/offsetHeight 恒为 0
        if (tip.classList) tip.classList.remove('hidden');
        shown = true;
        tipW = tip.offsetWidth || 0;
        tipH = tip.offsetHeight || 0;
      }

      // 避让:先试光标右下;右侧放不下(扣掉 avoidRight)翻到光标左侧;下侧放不下翻到上方;
      // 最后统一 clamp 到 canvas 内(浮窗永远不出图,海面/图外由 getHtml 返回 null 隐藏)
      let av = 0;
      if (avoidRight) {
        try { av = Number(avoidRight()) || 0; } catch (err) { av = 0; }
      }
      if (!(av > 0)) av = 0;
      const rightEdge = cw - av;
      let x = cx + OFF_X;
      let y = cy + OFF_Y;
      if (x + tipW > rightEdge - margin) x = cx - tipW - OFF_X;
      if (y + tipH > ch - margin) y = cy - tipH - OFF_Y;
      x = Math.max(margin, Math.min(x, cw - tipW - margin));
      y = Math.max(margin, Math.min(y, ch - tipH - margin));
      tip.style.transform = 'translate(' + Math.round(x) + 'px, ' + Math.round(y) + 'px)';
    }

    function tick() {
      frame = 0;
      if (!alive) return;
      render();
    }

    function schedule() {
      if (!alive || dragging || frame) return;
      frame = raf(tick);
    }

    /* ---------------- 事件 ---------------- */

    function onMove(e) {
      if (!alive) return;
      px = e.clientX;
      py = e.clientY;
      hasPoint = true;
      if (dragging) return; // 拖动中不更新,pointerup 后下一次移动再出现
      schedule();
    }

    function onDown() {
      if (!alive) return;
      dragging = true;
      hide(); // 点击/拖动一开始就收起,不等 pointerup
    }

    function onUp() {
      if (!alive) return;
      dragging = false;
    }

    function onCancel() {
      if (!alive) return;
      dragging = false;
      hasPoint = false;
      hide();
    }

    function onLeave() {
      if (!alive) return;
      hasPoint = false;
      hide();
    }

    map.addEventListener('pointermove', onMove);
    map.addEventListener('pointerdown', onDown);
    map.addEventListener('pointerup', onUp);
    map.addEventListener('pointercancel', onCancel);
    map.addEventListener('pointerleave', onLeave);

    // 兜底:canvas 没做 pointer capture 时,pointerup 可能落在外面,别让 dragging 卡死
    const doc = typeof document !== 'undefined' ? document : null;
    const docUp = function () { if (alive) dragging = false; };
    if (doc && typeof doc.addEventListener === 'function') {
      doc.addEventListener('pointerup', docUp);
      doc.addEventListener('pointercancel', docUp);
    }

    /** 强制按最近坐标重算(内容/数据变了但鼠标没动时用);返回是否正在显示 */
    function update() {
      if (!alive) return false;
      if (frame) { caf(frame); frame = 0; }
      if (dragging || !hasPoint) { hide(); return false; }
      render();
      return shown;
    }

    function destroy() {
      if (!alive) return;
      alive = false;
      if (frame) { caf(frame); frame = 0; }
      map.removeEventListener('pointermove', onMove);
      map.removeEventListener('pointerdown', onDown);
      map.removeEventListener('pointerup', onUp);
      map.removeEventListener('pointercancel', onCancel);
      map.removeEventListener('pointerleave', onLeave);
      if (doc && typeof doc.removeEventListener === 'function') {
        doc.removeEventListener('pointerup', docUp);
        doc.removeEventListener('pointercancel', docUp);
      }
      hide();
      if (current === inst) current = null;
    }

    const inst = {
      update: update,
      hide: hide,
      destroy: destroy,
      /** 最近一次指针位置(canvas 相对 CSS 像素),调试/测试用 */
      pointer: function () {
        if (!hasPoint) return null;
        const rect = typeof map.getBoundingClientRect === 'function' ? map.getBoundingClientRect() : null;
        return { x: px - (rect ? rect.left : 0), y: py - (rect ? rect.top : 0) };
      },
    };

    // 初始收起(不主动清空 HTML:内容由 app.js/getHtml 决定,第一次移动时整体重写)
    if (tip.classList) tip.classList.add('hidden');
    current = inst;
    return inst;
  }

  const API = {
    init: init,
    update: function () { return current ? current.update() : false; },
    hide: function () { if (current) current.hide(); },
    destroy: function () { if (current) current.destroy(); },
    /** 与 task-19 契约一致的默认间距/留白,Lead 的样式若不配套可参考 */
    OFFSET: { x: OFF_X, y: OFF_Y },
    MARGIN: DEF_MARGIN,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else globalThis.CivTooltip = API;
})();
