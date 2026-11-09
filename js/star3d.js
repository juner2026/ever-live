
/* =========================================================================
   星海 · 真 3D（WebGL1 手写，无外部库）
   - 银河带 + 星尘 + 体积云（fbm 噪声）+ 核心星与光线 + 记忆星
   - 单指拖动旋转 / 双指拖动平移 / 捏合缩放，带惯性
   - 点按涟漪 + 拖动星尘拖尾
   - 白日 / 黑夜两套配色，跟随「美化」主题色（低饱和）
   ========================================================================= */
(function(){
  var canvas = null, gl = null, host = null, ctx2d = null, sprite = null, use2D = false;
  var ready = false, running = false, raf = 0;
  /* DPR 大改：1.5 在 3.0+ DPR 屏上糊成一片。2.0 改善但仍差一档，抬到 2.5（83% 物理像素）。
     2D 路径 fillRect/stroke 不依赖 DPR 缩放，开销主要是 2D bloom 降采样画布（仍可控）。
     low 档兜底 1.25（弱机不至于掉帧）。 */
  /* ★ 之前只算 devicePixelRatio，没算 App 的平板缩放（html{zoom:1.4~1.5}）：
     画布按 CSS 像素 × DPR 建缓冲，显示时又被 zoom 放大一遍 → 等于降了 1.4 倍分辨率，
     在平板上就是"整片星海糊"。这里把 zoom 乘进去，并提高上限。 */
  function _pxRatio(){
    var z = 1;
    try{ z = parseFloat(String(getComputedStyle(document.documentElement).zoom||'1')); }catch(e){}
    if(!isFinite(z) || z <= 0) z = 1;
    return (window.devicePixelRatio || 1) * z;
  }
  var _rawDpr = _pxRatio();
  var DPR = Math.min(_rawDpr, window.TE_STAR_QUALITY === 'low' ? 1.25 : 4);
  /* 自适应绘制预算：帧时间偏高就自动少画些星，宁可少几颗也不能卡 */
  var drawBudget = 9000, _ftEma = 16;
  var _lastPoolN = 0, _lastDrawnN = 0;      /* 调试用：候选数与实际绘制数 */
  var target = [0, 0, 0], dist = 112, yaw = 0.6, pitch = 0.16;
  var _dayFrozen = 0, _dayFrozenDist = 112, _dayFrozenYaw = 0.6, _dayFrozenPitch = 0.16;
  var vYaw = 0.02, vPitch = 0.004, vDist = 0;
  var mode = 'night';            /* night | day */
  var modeT = 1;                 /* 昼夜过渡 0..1（1=夜） */
  var palette = null, paletteGoal = null;
  var time0 = performance.now();

  var THEME_HUE = { pink: 340, red: 356, orange: 25, yellow: 58, green: 138, blue: 214, purple: 284, teal: 175 };

  function themeHue(){
    try{
      var k = document.documentElement.getAttribute('data-te-hue') || 'pink';
      return (THEME_HUE[k] !== undefined) ? THEME_HUE[k] : 340;
    }catch(e){ return 340; }
  }
  /* 灰主题时整片海也去彩 */
  function isGrey(){ try{ return (document.documentElement.getAttribute('data-te-hue') || '') === 'grey'; }catch(e){ return false; } }
  function desat(v){ return isGrey() ? v * 0.22 : v; }
  function hsl(h, s, l, a){
    return [hslOne(h, s, l, 0), hslOne(h, s, l, 1), hslOne(h, s, l, 2), (a === undefined ? 1 : a)];
  }
  function hslOne(h, s, l, i){
    /* hsl -> rgb，返回 0..1 */
    h = ((h % 360) + 360) % 360 / 360; s = Math.max(0, Math.min(1, s)); l = Math.max(0, Math.min(1, l));
    if(s === 0){ return l; }
    var q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
    var t = [h + 1/3, h, h - 1/3][i];
    if(t < 0) t += 1; if(t > 1) t -= 1;
    if(t < 1/6) return p + (q - p) * 6 * t;
    if(t < 1/2) return q;
    if(t < 2/3) return p + (q - p) * (2/3 - t) * 6;
    return p;
  }
  /* 低饱和调色板 */
  function buildPalette(){
    var h = themeHue();
    /* 粉主题（基准色）压淡一点：底色抬亮、云和光都更柔 */
    var dPink = Math.abs(((h - 340 + 180) % 360) - 180);
    var soft = dPink < 10 ? 1 : 0;
    var bgL = soft ? 0.085 : 0.045;
    var nebS = desat(soft ? 0.30 : 0.42), nebL = soft ? 0.62 : 0.55;
    return {
      bg:      [hslOne(h + 6, desat(.40), bgL, 0), hslOne(h + 6, desat(.40), bgL, 1), hslOne(h + 6, desat(.40), bgL, 2)],
      starA:   hsl(h + 2,  desat(.10), .96),   /* 亮星：接近白，只有一丝主题色 */
      starB:   hsl(h,      desat(.14), .86),   /* 次亮 */
      starC:   hsl(h + 4,  desat(.18), .74),   /* 暗星 */
      nebA:    hsl(h + 10, nebS, nebL),
      nebB:    hsl(h - 18, nebS - .04, nebL - .06),
      ray:     hsl(h + 2,  .34, .80),
      memA:    hsl(h + 6,  .34, .88),
      memRing: hsl(h,      .30, .72),
      fx:      hsl(h + 8,  .34, .84)
    };
  }
  function lerp(a, b, t){ return a + (b - a) * t; }
  function lerpPal(a, b, t){
    if(!a) return b; if(!b) return a;
    var o = {};
    for(var k in a){ o[k] = [lerp(a[k][0], b[k][0], t), lerp(a[k][1], b[k][1], t), lerp(a[k][2], b[k][2], t), lerp(a[k][3] === undefined ? 1 : a[k][3], (b[k][3] === undefined ? 1 : b[k][3]), t)]; }
    return o;
  }
  function dayPalette(){
    var h = themeHue();
    return {
      bg:      [hslOne(h + 12, .30, .945, 0), hslOne(h + 12, .30, .945, 1), hslOne(h + 12, .30, .945, 2)],
      starA:   hsl(h + 2,  desat(.34), .40),
      starB:   hsl(h,      desat(.36), .52),
      starC:   hsl(h + 4,  desat(.30), .64),
      nebA:    hsl(h + 10, .30, .86),
      nebB:    hsl(h - 16, .26, .90),
      ray:     hsl(h + 2,  .40, .50),
      memA:    hsl(h + 6,  .42, .44),
      memRing: hsl(h,      .40, .52),
      fx:      hsl(h + 8,  .42, .48)
    };
  }

  /* ---------- 着色器 ---------- */
  var VS_POINT = [
    'attribute vec3 aPos; attribute vec4 aCol; attribute float aSize;',
    'uniform mat4 uVP; uniform vec3 uCam; uniform float uTime; uniform float uDpr;',
    'varying vec4 vCol;',
    'varying float vMag;',
    'varying float vMag;',
    'void main(){',
    '  gl_Position = uVP * vec4(aPos, 1.0);',
    '  float d = max(length(aPos - uCam), 1.0);',
    /* 收紧闪烁：幅度 0.14、频率 0.9（之前 0.32/1.6 像故障灯）。
       aCol.w 是每颗星的随机相位，要求 bakeColors 不要把它覆盖成 1。 */
    '  float ph = aCol.w * 6.2831;',
    '  float spd = 0.55 + 1.05 * fract(aCol.w * 7.13);',
    '  float tw = 0.86 + 0.09 * sin(uTime * spd + ph) + 0.05 * sin(uTime * spd * 1.73 + ph * 2.0);',
    /* 56 像素上限，给 FS_POINT 的衍射十字留空间（之前 42 截掉了一半光） */
    '  gl_PointSize = clamp(aSize * uDpr * tw * (420.0 / d), 1.5, 56.0);',
    '  vCol = vec4(aCol.rgb, tw);',
    '  vMag = clamp(aSize * 0.16, 0.0, 1.0);',
    '}'
  ].join('\n');

  var FS_POINT = [
    'precision highp float;',
    'varying vec4 vCol;',
    'void main(){',
    '  vec2 p = gl_PointCoord * 2.0 - 1.0;',
    '  float r2 = dot(p, p);',
    '  if(r2 > 1.0) discard;',
    /* 硬核：紧高斯，约 2-3 有效像素，是"星"感的关键
       （之前 exp(-r2*9.5) 在 56px 上是 12+ 像素的软球，远看就是糊的糖豆） */
    '  float core = exp(-r2 * 26.0);',
    /* 柔晕：宽低强度，给环境光感 */
    '  float halo = exp(-r2 * 3.2) * 0.30;',
    /* 衍射十字：每颗星都画，亮度自然由 a 缩放，亮星出尖刺、暗星只剩一抹光 */
    '  float ax = exp(-abs(p.x) * 14.0);',
    '  float ay = exp(-abs(p.y) * 14.0);',
    '  float bright = smoothstep(0.18, 0.9, vMag);',
    '  float spike = (ax + ay) * 0.22 * (0.35 + 0.65 * bright);',
    '  float a = (core * 1.35 + halo * (0.82 + 0.18 * bright) + spike) * vCol.a;',
    '  gl_FragColor = vec4(vCol.rgb * a, a);',
    '}'
  ].join('\n');

  var VS_QUAD = [
    'attribute vec2 aUv; uniform mat4 uVP; uniform vec3 uCenter; uniform vec3 uRight; uniform vec3 uUp; uniform float uSize;',
    'varying vec2 vUv;',
    'void main(){',
    '  vUv = aUv;',
    '  vec3 pos = uCenter + uRight * (aUv.x * 2.0 - 1.0) * uSize + uUp * (aUv.y * 2.0 - 1.0) * uSize;',
    '  gl_Position = uVP * vec4(pos, 1.0);',
    '}'
  ].join('\n');

  var FS_NEB = [
    'precision highp float;',
    'varying vec2 vUv;',
    'uniform vec3 uTint; uniform float uAlpha; uniform vec2 uSeed; uniform float uTime;',
    'float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }',
    'float noise(vec2 p){',
    '  vec2 i = floor(p), f = fract(p);',
    '  vec2 u = f * f * (3.0 - 2.0 * f);',
    '  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);',
    '}',
    'float fbm(vec2 p){',
    '  float v = 0.0, a = 0.5;',
    '  for(int i = 0; i < 5; i++){ v += a * noise(p); p *= 2.02; a *= 0.5; }',
    '  return v;',
    '}',
    'void main(){',
    '  vec2 p = vUv * 2.0 - 1.0;',
    '  float m = length(p);',
    '  if(m > 1.0) discard;',
    '  float soft = smoothstep(1.0, 0.05, m);',
    '  float n = fbm(vUv * 3.4 + uSeed + vec2(uTime * 0.013, uTime * -0.009));',
    '  float n2 = fbm(vUv * 7.0 - uSeed * 1.7 + uTime * 0.006);',
    '  float a = soft * pow(clamp(n * 0.75 + n2 * 0.45, 0.0, 1.6), 1.7) * uAlpha;',
    '  float dith = (hash(gl_FragCoord.xy) - 0.5) / 255.0;',
    '  vec3 col = clamp(uTint * a + dith, 0.0, 1.0);',
    '  gl_FragColor = vec4(col, a);',
    '}'
  ].join('\n');

  /* ---------- 程序与缓冲 ---------- */
  function compile(vs, fs){
    var v = gl.createShader(gl.VERTEX_SHADER); gl.shaderSource(v, vs); gl.compileShader(v);
    if(!gl.getShaderParameter(v, gl.COMPILE_STATUS)){ return null; }
    var f = gl.createShader(gl.FRAGMENT_SHADER); gl.shaderSource(f, fs); gl.compileShader(f);
    if(!gl.getShaderParameter(f, gl.COMPILE_STATUS)){ return null; }
    var p = gl.createProgram(); gl.attachShader(p, v); gl.attachShader(p, f); gl.linkProgram(p);
    if(!gl.getProgramParameter(p, gl.LINK_STATUS)){ return null; }
    p._u = {}; p._a = {};
    var n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for(var i = 0; i < n; i++){ var info = gl.getActiveUniform(p, i); p._u[info.name] = gl.getUniformLocation(p, info.name); }
    var na = gl.getProgramParameter(p, gl.ACTIVE_ATTRIBUTES);
    for(var j = 0; j < na; j++){ var ai = gl.getActiveAttrib(p, j); p._a[ai.name] = gl.getAttribLocation(p, ai.name); }
    return p;
  }

  var progPoint, progNeb, quadBuf, rayBuf, rayCap = 0;
  var galaxy = null, halo = null, near = null, swarm = null, dust = null, memStars = null, rays = null;
  var fx = { pos: null, col: null, size: null, n: 0, max: 900, head: 0 };
  var nebulas = [], dustLanes = [];
  var memories = [];
  var labels = [];

  function rnd(a, b){ return a + Math.random() * (b - a); }
  function gauss(){ var u = 0, v = 0; while(!u) u = Math.random(); while(!v) v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }

  /* 银河带：螺旋 + 厚度，制造"星海"主体 */
  function buildStars(count, kind){
    var pos = new Float32Array(count * 3), col = new Float32Array(count * 4), siz = new Float32Array(count);
    var arms = 4, R = 232;
    for(var i = 0; i < count; i++){
      var x, y, z, t;
      if(kind === 'dust'){
        var rr2 = 20 + Math.pow(Math.random(), 0.55) * 300;
        var th2 = Math.random() * Math.PI * 2, ph2 = Math.acos(rnd(-1, 1));
        x = rr2 * Math.sin(ph2) * Math.cos(th2);
        y = rr2 * Math.cos(ph2) * 0.62;
        z = rr2 * Math.sin(ph2) * Math.sin(th2);
        var s = 1;                       /* 全部当暗星处理，视觉上就是细尘 */
        col[i*4+0] = 2; col[i*4+1] = Math.random() * 0.5;
        siz[i] = rnd(0.45, 0.85);
      } else if(kind === 'swarm'){
        /* 聚在小船/漂流瓶那一带：矮胖的一团（半径必须远小于相机距离，否则全在屏幕外） */
        var rr1 = 3 + Math.pow(Math.random(), 0.6) * 20;
        var th1 = Math.random() * Math.PI * 2;
        x = Math.cos(th1) * rr1;
        z = Math.sin(th1) * rr1;
        y = -30 + gauss() * 12;
        var s = Math.random();
        siz[i] = siz[i] * 1.15;
      } else if(kind === 'near'){
        var nearBoost = 2.0;
        var rr0 = 10 + Math.pow(Math.random(), 0.7) * 38;
        var th0 = Math.random() * Math.PI * 2, ph0 = Math.acos(rnd(-1, 1));
        x = rr0 * Math.sin(ph0) * Math.cos(th0);
        y = rr0 * Math.cos(ph0) * 0.55 - 6;
        z = rr0 * Math.sin(ph0) * Math.sin(th0);
        var s = Math.random();
        siz[i] = siz[i] * 2.0;
      } else if(false){
      } else if(kind === 'galaxy'){
        var a = Math.pow(Math.random(), 0.62);
        var arm = Math.floor(Math.random() * arms);
        var ang = a * 6.6 + arm * (Math.PI * 2 / arms) + gauss() * 0.14;
        var r = 22 + a * R;
        x = Math.cos(ang) * r + gauss() * 9;
        z = Math.sin(ang) * r + gauss() * 9;
        y = gauss() * (5 + 11 * Math.pow(1 - a, 1.7));
        var s = Math.random();
      } else {
        var u = Math.random();
        var rr = u < 0.6 ? (120 + Math.pow(Math.random(), 0.8) * 230) : (350 + Math.pow(Math.random(), 0.7) * 430);
        var th = Math.random() * Math.PI * 2, ph = Math.acos(rnd(-1, 1));
        x = rr * Math.sin(ph) * Math.cos(th);
        y = rr * Math.cos(ph) * 0.55;
        z = rr * Math.sin(ph) * Math.sin(th);
        var s = Math.random();
      }
      pos[i*3] = x; pos[i*3+1] = y; pos[i*3+2] = z;
      var k = s < 0.11 ? 0 : (s < 0.36 ? 1 : 2);
      col[i*4+3] = Math.random();
      col[i*4+0] = k;                          /* 0/1/2 表示用哪一档颜色，渲染时映射 */
      col[i*4+1] = Math.random();              /* 随机亮度 */
      col[i*4+2] = (Math.random() * 5) | 0;    /* 色温档 0..4：冷暖层次（渲染时也按星号哈希重取） */
      siz[i] = k === 0 ? rnd(2.6, 4.6) : (k === 1 ? rnd(1.5, 2.4) : rnd(0.9, 1.5));
    }
    return { pos: pos, col: col, siz: siz, count: count };
  }

  function makeBuffer(data){ var b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW); return b; }

  var sceneBuilt = false;
  function buildScene(){
    if(sceneBuilt) return;
    sceneBuilt = true;
    var low = (window.TE_STAR_QUALITY === 'low');
    near = buildStars(low ? 900 : 8000, 'near');
    swarm = buildStars(low ? 900 : 11000, 'swarm');
    dust = buildStars(low ? 1500 : 14000, 'dust');   /* 极细星尘：让整片海更细腻 */   /* 围着船和瓶子的星群 */
    galaxy = buildStars(low ? 3500 : 30000, 'galaxy');
    halo = buildStars(low ? 2200 : 30000, 'halo');

    /* 云团：沿银河带撒，宁多勿大 —— 大团糊云正是"粗糙"的来源。
       尺度收小、数量加多，靠重叠堆出结构，大范围辉光交给银带层和泛光去做。
       每朵都带自己的自转 + 呼吸参数，云才会真正"活"起来，而不是一张死贴图 */
    nebulas = []; dustLanes = [];
    var arms = 4;
    function makeNeb(rr, angle, aa, dark){
      return {
        c: [Math.cos(angle) * rr + gauss() * 22, gauss() * (10 + 22 * (1 - aa)), Math.sin(angle) * rr + gauss() * 22],
        size: dark ? rnd(50, 135) : rnd(32, 98),
        a: dark ? rnd(0.22, 0.40) : rnd(0.065, 0.17),
        /* 从固定种子里取：噪声图按种子缓存，共用几种就不必现算几十张 fbm，首次进入不卡 */
        seed: [NEB_SEEDS[(Math.random() * NEB_SEEDS.length) | 0], Math.random() * 10],
        tint: dark ? 'nebB' : (Math.random() < 0.55 ? 'nebA' : 'nebB'),
        rot: Math.random() * 6.2832,
        rotSpd: rnd(-0.035, 0.035),          /* 自己慢慢转 */
        pulsePh: Math.random() * 6.2832,
        pulseSpd: rnd(0.05, 0.17)             /* 自己慢慢呼吸 */
      };
    }
    if(!low) for(var i = 0; i < 46; i++){
      var a2 = Math.pow(Math.random(), 0.7), arm = Math.floor(Math.random() * arms);
      var ang = a2 * 6.6 + arm * (Math.PI * 2 / arms) + gauss() * 0.2;
      var r2 = 30 + a2 * 200;
      nebulas.push(makeNeb(r2, ang, a2, false));
      /* 暗尘带：贴着旋臂撒，稍后用 multiply 压暗 → 明暗相间的真实层次 */
      if(Math.random() < 0.6){
        var dl = makeNeb(r2 * rnd(0.86, 1.05), ang + rnd(-0.16, 0.16), a2, true);
        dl.c[1] *= 0.45;                     /* 压向银盘面，尘带才贴得住 */
        dustLanes.push(dl);
      }
    }
    if(!low) nebulas.push({ c: [0, 0, 0], size: 120, a: 0.16, seed: [3.1, 7.7], tint: 'nebA',
      rot: 0, rotSpd: 0.012, pulsePh: 1.1, pulseSpd: 0.09 });

    /* 光线：从核心连到近处的亮星 */
    rays = [];
    var gpos = galaxy.pos, cnt = 0;
    for(var j = 0; j < 0 && cnt < 0; j++){
      var idx = Math.floor(Math.random() * galaxy.count);
      var px = gpos[idx*3], py = gpos[idx*3+1], pz = gpos[idx*3+2];
      var len = Math.sqrt(px*px + py*py + pz*pz);
      if(len < 55 || len > 190) continue;
      var N = 40, pts = [];
      for(var k = 0; k < N; k++){
        var tt = k / (N - 1);
        pts.push([
          px * tt + Math.sin(tt * 9.1 + j) * 2.2,
          py * tt + Math.sin(tt * Math.PI) * 14 * (py >= 0 ? 1 : -1) + Math.cos(tt * 7.3 + j) * 2.2,
          pz * tt + Math.sin(tt * 5.7 + j) * 2.2
        ]);
      }
      rays.push({ pts: pts, phase: Math.random() * 6.28, speed: rnd(0.10, 0.22) });
      cnt++;
    }
    rayCap = Math.max(1, rays.length * 40);
    rayBuf = { rp: new Float32Array(rayCap * 3), rc: new Float32Array(rayCap * 4), rs: new Float32Array(rayCap) };

    /* 特效粒子（涟漪 / 拖尾）——CPU 侧数据 */
    fx.pos = new Float32Array(fx.max * 3);
    fx.col = new Float32Array(fx.max * 4);
    fx.size = new Float32Array(fx.max);
    fx.life = new Float32Array(fx.max);
    fx.vel = new Float32Array(fx.max * 3);

    buildMemories();
    prepSpin();                           /* 自转分桶 + 尘埃消光，只算这一次 */
  }

  function initGL(){
    canvas = document.getElementById('teStarCanvas');
    if(!canvas) return false;
    bindLost();
    if(!window.TE_STAR_USE_GL){ to2D(); return false; }   /* 默认走 Canvas2D：任何设备都能出画面 */
    gl = canvas.getContext('webgl', { antialias: false, alpha: false, premultipliedAlpha: true, powerPreference: 'high-performance' })
      || canvas.getContext('experimental-webgl', { antialias: false, alpha: false });
    if(!gl){ to2D(); return false; }
    progPoint = compile(VS_POINT, FS_POINT);
    progNeb = compile(VS_QUAD, FS_NEB);
    if(!progPoint || !progNeb){ to2D(); return false; }
    quadBuf = makeBuffer(new Float32Array([0,0, 1,0, 0,1, 1,0, 1,1, 0,1]));
    buildScene();
    galaxy.buf = { pos: makeBuffer(galaxy.pos), col: makeBuffer(galaxy.col), siz: makeBuffer(galaxy.siz) };
    halo.buf = { pos: makeBuffer(halo.pos), col: makeBuffer(halo.col), siz: makeBuffer(halo.siz) };
    near.buf = { pos: makeBuffer(near.pos), col: makeBuffer(near.col), siz: makeBuffer(near.siz) };
    swarm.buf = { pos: makeBuffer(swarm.pos), col: makeBuffer(swarm.col), siz: makeBuffer(swarm.siz) };
    dust.buf = { pos: makeBuffer(dust.pos), col: makeBuffer(dust.col), siz: makeBuffer(dust.siz) };
    if(memStars){ memStars.buf = { pos: makeBuffer(memStars.pos), col: makeBuffer(memStars.col), siz: makeBuffer(memStars.siz) }; }
    rayBuf.pos = gl.createBuffer(); rayBuf.col = gl.createBuffer(); rayBuf.siz = gl.createBuffer();
    fx.buf = { pos: gl.createBuffer(), col: gl.createBuffer(), siz: gl.createBuffer() };
    window.__starGL = gl;
    return true;
  }
  /* ★ 修复：这里原来还有一份重复的 initGL()，把上面那份覆盖掉了。
     被覆盖的版本漏掉了 progPoint/progNeb 的编译（着色器为空 → 开 WebGL 就黑屏）。
     已连同它残留的函数头一起删除。 */

  /* ---------- 记忆星 ---------- */
  function loadMemories(){
    var out = [];
    try{
      var db = JSON.parse(localStorage.getItem('memdb') || 'null');
      if(db && db.entries){
        var banks = {}; (db.banks || []).forEach(function(b){ banks[b.id] = b.name; });
        out = db.entries.filter(function(e){ return e && e.text; }).map(function(e){
          var st = 1;
          try{ if(typeof memStrength === 'function') st = memStrength(e) || 1; }catch(x){}
          return { text: String(e.text).replace(/\s+/g, ' ').trim(), bank: banks[e.bank] || '记忆', strength: st, at: e.at || e.created || 0 };
        });
      }
    }catch(e){}
    out.sort(function(a, b){ return b.strength - a.strength; });
    return out.slice(0, 42);
  }
  function buildMemories(){
    var all = loadMemories();
    memories = all;
    var n = all.length;
    window.__starMemCount = n;
    document.getElementById('teStarSub') && (document.getElementById('teStarSub').textContent =
      n ? (all.length + ' 条记忆沉在这片海里') : 'NAMELESS COASTLINE · v109');
    var pos = new Float32Array(Math.max(1, n) * 3), col = new Float32Array(Math.max(1, n) * 4), siz = new Float32Array(Math.max(1, n));
    for(var i = 0; i < n; i++){
      var a = i * 2.399963;                      /* 黄金角排布，自然分散 */
      var r = 40 + Math.pow(i / Math.max(1, n - 1), 0.65) * 175;
      var x = Math.cos(a) * r, z = Math.sin(a) * r, y = gauss() * 12;
      pos[i*3] = x; pos[i*3+1] = y; pos[i*3+2] = z;
      col[i*4] = 3; col[i*4+1] = 0.6 + Math.min(1, all[i].strength / 8) * 0.4; col[i*4+2] = 0; col[i*4+3] = Math.random();
      siz[i] = 2.4 + Math.min(1.6, all[i].strength / 6);
    }
    memStars = { pos: pos, col: col, siz: siz, count: n };
    prepExtras(memStars, false, 97);      /* 记忆星也要分桶，才能跟着星海一起转且点得准 */
    if(gl) memStars.buf = { pos: makeBuffer(pos), col: makeBuffer(col), siz: makeBuffer(siz) };
    buildLabels(n);
  }
  function buildLabels(n){
    var box = document.getElementById('teStarLabels'); if(!box) return;
    box.innerHTML = ''; labels = [];
    var show = Math.min(n, 7);
    for(var i = 0; i < show; i++){
      var d = document.createElement('div');
      d.className = 'st-label';
      var t = memories[i].text || '';
      var dt = memories[i].at ? new Date(memories[i].at) : null;
      d.innerHTML = '<span class="st-dot"></span><b>' + esc(t.slice(0, 16)) + '</b><i>' +
        esc(memories[i].bank) + (dt ? ' · ' + (dt.getMonth() + 1) + '.' + dt.getDate() : '') + '</i>';
      box.appendChild(d);
      labels.push({ el: d, i: i });
    }
  }
  function esc(s){ return String(s).replace(/[&<>"]/g, function(c){ return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  /* ---------- 数学 ---------- */
  function perspective(fovy, aspect, near, far){
    var f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
    return new Float32Array([f / aspect,0,0,0, 0,f,0,0, 0,0,(far + near) * nf,-1, 0,0,2 * far * near * nf,0]);
  }
  function lookAt(eye, center, up){
    var z0 = eye[0] - center[0], z1 = eye[1] - center[1], z2 = eye[2] - center[2];
    var l = Math.hypot(z0, z1, z2) || 1; z0 /= l; z1 /= l; z2 /= l;
    var x0 = up[1] * z2 - up[2] * z1, x1 = up[2] * z0 - up[0] * z2, x2 = up[0] * z1 - up[1] * z0;
    l = Math.hypot(x0, x1, x2) || 1; x0 /= l; x1 /= l; x2 /= l;
    var y0 = z1 * x2 - z2 * x1, y1 = z2 * x0 - z0 * x2, y2 = z0 * x1 - z1 * x0;
    return new Float32Array([
      x0, y0, z0, 0, x1, y1, z1, 0, x2, y2, z2, 0,
      -(x0*eye[0] + x1*eye[1] + x2*eye[2]), -(y0*eye[0] + y1*eye[1] + y2*eye[2]), -(z0*eye[0] + z1*eye[1] + z2*eye[2]), 1
    ]);
  }
  function mul(a, b){
    var o = new Float32Array(16);
    for(var i = 0; i < 4; i++) for(var j = 0; j < 4; j++){
      var s = 0; for(var k = 0; k < 4; k++) s += a[k*4+j] * b[i*4+k];
      o[i*4+j] = s;
    }
    return o;
  }

  /* ---------- 特效粒子 ---------- */
  function spawn(p, v, col, size, life){
    var i = fx.head; fx.head = (fx.head + 1) % fx.max;
    fx.pos[i*3] = p[0]; fx.pos[i*3+1] = p[1]; fx.pos[i*3+2] = p[2];
    fx.vel[i*3] = v[0]; fx.vel[i*3+1] = v[1]; fx.vel[i*3+2] = v[2];
    fx.col[i*4] = 4; fx.col[i*4+1] = col[0]; fx.col[i*4+2] = col[1]; fx.col[i*4+3] = 0;
    fx.size[i] = size; fx.life[i] = life;
  }
  function ripple(world, big){
    var n = big ? 110 : 76, R = big ? 1.5 : 1.0;
    for(var i = 0; i < n; i++){
      var a = i / n * Math.PI * 2 + Math.random() * 0.12;
      var sp = rnd(6, 13) * R;
      spawn(world, [Math.cos(a) * sp, Math.sin(a) * sp * 0.55, Math.sin(a * 1.6) * sp * 0.6],
            [1, rnd(0.6, 1)], rnd(0.5, 1.0), rnd(0.40, 0.70));
    }
    for(var j = 0; j < 10; j++){
      spawn(world, [gauss() * 1.6, gauss() * 1.6, gauss() * 1.6], [1, 0.7], rnd(4, 7), rnd(0.26, 0.45));
    }
  }
  var _lastTrail = null;
  function trail(world){
    if(!_lastTrail){ _lastTrail = world; return; }
    var dx = world[0] - _lastTrail[0], dy = world[1] - _lastTrail[1], dz = world[2] - _lastTrail[2];
    var d = Math.sqrt(dx*dx + dy*dy + dz*dz);
    var step = 1.7, n = Math.min(7, Math.floor(d / step));
    for(var i = 1; i <= n; i++){
      var t = i / (n + 1);
      var px = _lastTrail[0] + dx*t, py = _lastTrail[1] + dy*t, pz = _lastTrail[2] + dz*t;
      /* 细碎的星尘（3 颗 + 1 团极淡的雾） */
      for(var q = 0; q < 3; q++){
        spawn([px + gauss() * 0.9, py + gauss() * 0.9, pz + gauss() * 0.9],
              [gauss() * 0.5, gauss() * 0.5, gauss() * 0.5], [1, rnd(0.5, 1)], rnd(0.34, 0.62), rnd(0.20, 0.42));
      }
      if(Math.random() < 0.5){
        spawn([px, py, pz], [gauss() * 0.2, gauss() * 0.2, gauss() * 0.2], [1, 0.5], rnd(3.2, 5.6), rnd(0.28, 0.5));
      }
    }
    _lastTrail = world;
  }
  function trailEnd(){ _lastTrail = null; }

  /* ---------- Canvas2D 兜底渲染（真机一般用不到，弱机/异常时保底） ---------- */
  function to2D(){
    if(use2D) return;
    use2D = true; ready = false;
    try{ console.log('[star] 走 2D 兜底（WebGL 没起来）dpr='+DPR.toFixed(2)+' raw='+_rawDpr.toFixed(2)); }catch(e){}
    function _report(msg){
      try{ if(window.parent && window.parent.__teErrAdd) window.parent.__teErrAdd('[星海] '+msg, 'canvas '+(canvas?canvas.width+'x'+canvas.height:'无')); }catch(e){}
      try{ window.__starErr = msg; }catch(e){}
    }
    try{
      var old = canvas, nc = document.createElement('canvas');
      nc.id = 'teStarCanvas';
      nc.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;touch-action:none';
      /* ★ 12.38：canvas 万一已经不在 DOM 里（parentNode 为空），replaceChild 会抛，
         然后 ctx2d 被留成 null —— 之后每一帧 render2D 直接 return，屏幕就是纯黑。
         这里分开兜：换不了就直接用原画布，绝不让 ctx2d 变 null。 */
      try{
        if(old && old.parentNode) old.parentNode.replaceChild(nc, old);
        else { nc = old; }
      }catch(e){ nc = old; _report('换画布失败，改用原画布：'+String(e&&e.message||e)); }
      canvas = nc;
      ctx2d = nc.getContext('2d');
      gl = null;
      if(!ctx2d){ _report('拿不到 2D 上下文'); return; }
      DPR = Math.min(_rawDpr, window.TE_STAR_QUALITY === 'low' ? 1.25 : 2.5);
      try{ buildScene(); }catch(e){ _report('buildScene 抛：'+String(e&&e.message||e)); }
      try{ sprite = starSprite([1,1,1], 'white'); }catch(e){ _report('星星贴图抛：'+String(e&&e.message||e)); }
      try{ bindInput2D(); }catch(e){}
      try{ resize(); }catch(e){}
    }catch(e){
      _report('2D 兜底整体失败：'+String(e&&e.message||e));
    }
  }
  function rgbStr(c){ return 'rgb(' + Math.round(c[0]*255) + ',' + Math.round(c[1]*255) + ',' + Math.round(c[2]*255) + ')'; }
  var HUE_SETS = [-5, -2, 0, 2, 5];
  function shiftHue(c, deg){
    var r = Math.max(0, Math.min(1, c[0])), g = Math.max(0, Math.min(1, c[1])), b = Math.max(0, Math.min(1, c[2]));
    var mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, h = 0, sat = 0, d = mx - mn;
    if(d > 0.0001){
      sat = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
      if(mx === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
      else if(mx === g) h = ((b - r) / d + 2) / 6;
      else h = ((r - g) / d + 4) / 6;
    }
    h = ((h * 360 + deg) % 360 + 360) % 360 / 360;
    if(sat === 0) return [l, l, l, c[3] === undefined ? 1 : c[3]];
    var q = l < 0.5 ? l * (1 + sat) : l + sat - l * sat, p = 2 * l - q;
    function hue2rgb(t){ if(t < 0) t += 1; if(t > 1) t -= 1; if(t < 1/6) return p + (q - p) * 6 * t; if(t < 1/2) return q; if(t < 2/3) return p + (q - p) * (2/3 - t) * 6; return p; }
    return [hue2rgb(h + 1/3), hue2rgb(h), hue2rgb(h - 1/3), c[3] === undefined ? 1 : c[3]];
  }
  var tintCache = {};
  /* exLv 0..3 星际消光档位：被尘埃挡住的星会偏红变暗（红化），不是单纯调低亮度 */
  var EXT_RED = [0, 0.20, 0.40, 0.62];
  function starTint(kind, vi, exLv){
    exLv = exLv | 0;
    var key = kind + '_' + vi + '_' + exLv;
    if(tintCache[key]) return tintCache[key];
    var base = kind === 0 ? palette.starA : (kind === 1 ? palette.starB : (kind === 2 ? palette.starC : palette.memA));
    /* 真实星色来自"色温"：偏暖(橙) ↔ 偏冷(蓝白)，而不是转色相 */
    var TEMPS = [
      [1.00, 0.84, 0.62],   /* 0 暖：橙黄 */
      [1.00, 0.94, 0.83],   /* 1 微暖 */
      [1.00, 1.00, 1.00],   /* 2 中性 */
      [0.86, 0.93, 1.00],   /* 3 微冷 */
      [0.74, 0.85, 1.00]    /* 4 冷：蓝白 */
    ];
    var tp = TEMPS[(vi + 5) % 5];
    var k = kind === 2 ? 0.34 : (kind === 1 ? 0.5 : 0.62);   /* 暗星颜色更淡，亮星颜色更明显 */
    var c = [
      base[0] * (1 - k) + base[0] * tp[0] * k,
      base[1] * (1 - k) + base[1] * tp[1] * k,
      base[2] * (1 - k) + base[2] * tp[2] * k,
      base[3] === undefined ? 1 : base[3]
    ];
    /* 消光红化：蓝光被尘埃散射得最狠，红光穿透力最强 */
    var ex = EXT_RED[exLv];
    if(ex > 0){
      c[0] *= 1 - ex * 0.28;
      c[1] *= 1 - ex * 0.55;
      c[2] *= 1 - ex * 0.85;
    }
    tintCache[key] = c;
    return c;
  }
  function rgbaStr(c, a){ return 'rgba(' + Math.round(c[0]*255) + ',' + Math.round(c[1]*255) + ',' + Math.round(c[2]*255) + ',' + a + ')'; }
  /* 星星光晕精灵：按颜色缓存，夜色用加法叠加 */
  var starSprites = {};
  function colKey(col){ return 'c' + Math.round(col[0]*255) + '_' + Math.round(col[1]*255) + '_' + Math.round(col[2]*255); }
  function starSprite(col, key){
    key = key ? (colKey(col) + '_' + key) : colKey(col);
    if(starSprites[key]) return starSprites[key];
    /* 大改：72→144。精灵尺寸 2x，drawImage 缩放比减半 → 模糊降一半 */
    var S = 144, c = document.createElement('canvas'); c.width = c.height = S;
    var x = c.getContext('2d');
    var g = x.createRadialGradient(S/2, S/2, 0, S/2, S/2, S/2);
    g.addColorStop(0, rgbaStr(col, 0.98));
    g.addColorStop(0.16, rgbaStr(col, 0.62));
    g.addColorStop(0.42, rgbaStr(col, 0.20));
    g.addColorStop(0.72, rgbaStr(col, 0.05));
    g.addColorStop(1, rgbaStr(col, 0));
    x.fillStyle = g; x.fillRect(0, 0, S, S);
    starSprites[key] = c;
    return c;
  }
  /* 紧致星点精灵：亮核 + 快速衰减，专给小星用（比大方块细腻得多） */
  var dotSprites = {};
  function starDot(col){
    var key = 'd' + colKey(col);
    if(dotSprites[key]) return dotSprites[key];
    /* 2x：48→96。小星精灵也 2x，避免双线性糊化 */
    var S = 96, c = document.createElement('canvas'); c.width = c.height = S;
    var x = c.getContext('2d'), h = S / 2;
    var g = x.createRadialGradient(h, h, 0, h, h, h);
    g.addColorStop(0.00, rgbaStr(col, 1.00));
    g.addColorStop(0.11, rgbaStr(col, 0.82));
    g.addColorStop(0.26, rgbaStr(col, 0.30));
    g.addColorStop(0.48, rgbaStr(col, 0.075));
    g.addColorStop(0.72, rgbaStr(col, 0.016));
    g.addColorStop(1.00, rgbaStr(col, 0));
    x.fillStyle = g; x.fillRect(0, 0, S, S);
    /* 中间一颗极小的高光核：让星点有"刺眼"的一点 */
    var g2 = x.createRadialGradient(h, h, 0, h, h, h * 0.085);
    g2.addColorStop(0, 'rgba(255,255,255,0.95)');
    g2.addColorStop(1, 'rgba(255,255,255,0)');
    x.fillStyle = g2; x.fillRect(0, 0, S, S);
    dotSprites[key] = c;
    return c;
  }
  /* 亮星过曝核：中心一段"实心"，不是纯渐变。
     纯渐变的高光只占半径的 8.5%，十几像素的星点上还不到一个像素，
     所以全画面最亮也只有 173；实心核才能让核心真的亮到 255 并占住几个像素。 */
  var coreSprites = {};
  function starCore(col){
    var key = 'c' + colKey(col);
    if(coreSprites[key]) return coreSprites[key];
    /* 2x：48→96 */
    var S = 96, c = document.createElement('canvas'); c.width = c.height = S;
    var x = c.getContext('2d'), h = S / 2;
    var g = x.createRadialGradient(h, h, 0, h, h, h);
    g.addColorStop(0.00, rgbaStr(col, 1.00));
    g.addColorStop(0.42, rgbaStr(col, 0.96));
    g.addColorStop(0.62, rgbaStr(col, 0.40));
    g.addColorStop(0.84, rgbaStr(col, 0.09));
    g.addColorStop(1.00, rgbaStr(col, 0));
    x.fillStyle = g; x.fillRect(0, 0, S, S);
    coreSprites[key] = c;
    return c;
  }
  /* 整数哈希 → 稳定的 0..1 随机（每颗星固定不变） */
  function h01(i, seed){
    var h = Math.imul(i ^ seed, 2246822519);
    h = Math.imul(h ^ (h >>> 13), 3266489917);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }

  /* ===================== 自转 · 消光 · 泛光（真实感三件套） =====================
     1) 星海自转：整体图案按刚体角速度旋转（保住旋臂），再叠加"本轮"摆动做出
        内圈外圈不同步的差速手感。刻意不用恒定角速度做内快外慢——那会在十几分钟
        内把旋臂彻底缠死（星系动力学的 winding problem，真实星系靠密度波规避）。
        这里用有界摆动：看着一直在拧、在呼吸，但永远不散架。
     2) 星际消光：贴盘面的星被尘埃挡暗并偏红，做出明暗层次与暗尘带
     3) 泛光 bloom：亮处向外溢光，不再是硬邦邦的圆点
     ========================================================================= */
  var SPIN_BUCKETS = 28, SPIN_BW = 12;        /* 半径分桶，避免每帧逐星三角函数 */
  var _ca = new Float32Array(SPIN_BUCKETS), _sa = new Float32Array(SPIN_BUCKETS);
  var PATTERN_W = 0.0055;                     /* 整体图案角速度（刚体，绕一圈约 19 分钟） */
  /* 旋转角 = 刚体项 + 两个不同频率的有界摆动 */
  function spinAngleAt(t, b){
    var ph = b * 0.55;
    return t * PATTERN_W
      + 0.062 * Math.sin(t * (0.115 + 0.0035 * b) + ph)
      + 0.024 * Math.sin(t * 0.33 + ph * 1.7);
  }
  /* 径向呼吸：整片海极缓慢地收放，像潮汐 */
  function spinScaleAt(t, b){ return 1 + 0.020 * Math.sin(t * (0.095 + 0.0028 * b) + b * 0.7); }
  function spinBucketAt(x, z){
    var b = (Math.sqrt(x * x + z * z) / SPIN_BW) | 0;
    return b > SPIN_BUCKETS - 1 ? SPIN_BUCKETS - 1 : (b < 0 ? 0 : b);
  }
  /* 每帧只算 28 次三角函数，供全部 9 万颗星共用 */
  function spinTable(t){
    for(var b = 0; b < SPIN_BUCKETS; b++){
      var a = spinAngleAt(t, b), s = spinScaleAt(t, b);
      _ca[b] = Math.cos(a) * s; _sa[b] = Math.sin(a) * s;
    }
  }
  /* 暗尘带颜色：偏暖的深灰棕。配合 multiply 压暗，红光衰减最少 → 尘带后的星偏红 */
  var DUST_TINT = [0.36, 0.29, 0.31];
  /* 星光强度三档：总增益与泛光一起换。
     单压 alpha 治不了刺眼，光晕扩散（泛光）才是"晃眼"的隐形来源。 */
  var STAR_ICONS = {
    pen:'<svg viewBox="0 0 24 24"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>',
    moon:'<svg viewBox="0 0 24 24"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>',
    sun:'<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
    glow0:'<svg viewBox="0 0 24 24"><path d="M12 6l1.3 3.7L17 11l-3.7 1.3L12 16l-1.3-3.7L7 11l3.7-1.3z"/></svg>',
    glow1:'<svg viewBox="0 0 24 24"><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/></svg>',
    glow2:'<svg viewBox="0 0 24 24"><path d="M11 3l1.7 4.6L17 9.3l-4.3 1.7L11 15.6l-1.7-4.6L5 9.3l4.3-1.7z"/><path d="M18 14l.9 2.4L21 17.3l-2.1.9L18 20.6l-.9-2.4L15 17.3l2.1-.9z"/></svg>',
    reset:'<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="7"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/></svg>'
  };
  /* bloom 再砍：用户报"好亮"，把 0.10/0.16/0.22 砍到 0.04/0.07/0.10。
     亮星有硬核 fillRect 撑着，bloom 只给最亮的几颗一点溢光。 */
  var GLOW_PRESETS = [
    { name: '柔和', gain: 0.70, bloom: 0.04, spike: 0.60 },
    { name: '标准', gain: 0.90, bloom: 0.07, spike: 1.00 },
    { name: '清晰', gain: 1.00, bloom: 0.10, spike: 1.40 }
  ];
  var glowIdx = 1;
  var STAR_GAIN = GLOW_PRESETS[1].gain;
  var BLOOM_NIGHT = GLOW_PRESETS[1].bloom;
  var SPIKE_GAIN  = GLOW_PRESETS[1].spike;
  function applyGlow(i){
    glowIdx = Math.max(0, Math.min(GLOW_PRESETS.length - 1, i | 0));
    var g = GLOW_PRESETS[glowIdx];
    STAR_GAIN = g.gain; BLOOM_NIGHT = g.bloom; SPIKE_GAIN = g.spike;
    try{ localStorage.setItem('te_star_glow_v3', String(glowIdx)); }catch(e){}
    var b = document.getElementById('teStarGlow');
    /* ★ 图标改成内联 SVG：以前用 ✧✦✺ 这种字体符号，很多设备上没有对应字形，
       会渲染成一个空方框（我这边截图里就是四个 □）。 */
    if(b) b.innerHTML = STAR_ICONS['glow' + glowIdx];   /* 柔和 / 标准 / 璀璨 */
  }
  try{
    var _sg = localStorage.getItem('te_star_glow_v3');
    if(_sg !== null && _sg !== undefined) applyGlow(parseInt(_sg, 10) || 0);
  }catch(e){}
  var NEB_SEEDS = [1.7, 3.9, 6.1, 8.3, 2.5, 5.3, 7.9, 4.7];
  var NEB_RAD_MAX = 620;      /* 云精灵半径上限：无上限时一张 160px 噪声图会被拉到 3500px，又糊又费 */
  /* 预计算：自转分桶 + 尘埃消光系数（只算一次） */
  function prepExtras(set, isDisk, seed){
    if(!set || !set.pos || set.bkt) return;
    var n = set.count, bkt = new Uint8Array(n), ext = new Float32Array(n);
    for(var i = 0; i < n; i++){
      var x = set.pos[i*3], y = set.pos[i*3+1], z = set.pos[i*3+2];
      bkt[i] = spinBucketAt(x, z);
      if(isDisk){
        /* 越贴盘面、离核心越远，尘埃遮挡越重；再用哈希打碎成一条条暗带 */
        var plane = Math.exp(-Math.abs(y) / 15);
        var nz = h01(i, seed + 4241);
        ext[i] = plane * (0.30 + 0.70 * nz * nz) * (0.55 + 0.45 * Math.min(1, Math.sqrt(x*x + z*z) / 180));
      }
    }
    set.bkt = bkt; set.ext = ext;
  }
  var spinReady = false;
  function prepSpin(){
    if(spinReady) return;
    spinReady = true;
    try{
      prepExtras(dust, false, 11); prepExtras(swarm, false, 23); prepExtras(near, false, 37);
      prepExtras(galaxy, true, 53); prepExtras(halo, true, 71); prepExtras(memStars, false, 97);
    }catch(e){}
  }

  /* ---- 泛光：两级降采样把亮部晕开（不依赖 ctx.filter，任何 WebView 都能用） ---- */
  var bloomA = null, bloomB = null;
  var _bloomA = null, _bloomACtx = null, _bloomB = null, _bloomBCtx = null, _bloomList = [];
  /* 选择性泛光：只把亮星画进低分辨率缓冲再叠回主画布。
     整帧泛光会把暗部一起抬起来 —— 那正是"刺眼"的根源；只晕高光才有真实镜头感。 */
  function selectiveBloom(W, H, list, strength){
    if(!(strength > 0) || list.length < 5 || !ctx2d) return;
    var q = 4, bw = Math.max(1, Math.round(W / q)), bh = Math.max(1, Math.round(H / q));
    if(!_bloomA || _bloomA.width !== bw || _bloomA.height !== bh){
      _bloomA = document.createElement('canvas'); _bloomA.width = bw; _bloomA.height = bh; _bloomACtx = _bloomA.getContext('2d');
      _bloomB = document.createElement('canvas'); _bloomB.width = bw; _bloomB.height = bh; _bloomBCtx = _bloomB.getContext('2d');
    }
    var A = _bloomACtx, B = _bloomBCtx;
    A.globalCompositeOperation = 'source-over'; A.globalAlpha = 1;
    A.clearRect(0, 0, bw, bh);
    A.globalCompositeOperation = 'lighter';
    for(var i = 0; i < list.length; i += 5){
      var d = list[i+2] * 3.2 / q;
      if(d < 1.2) continue;
      A.globalAlpha = Math.min(.8, list[i+3] * .5);
      A.drawImage(starSprite(list[i+4]), list[i]/q - d/2, list[i+1]/q - d/2, d, d);
    }
    /* 降采样再放大本身就是模糊；再四向错位自叠，光晕更宽更软 */
    B.globalCompositeOperation = 'source-over'; B.globalAlpha = 1;
    B.clearRect(0, 0, bw, bh);
    B.drawImage(_bloomA, 0, 0);
    A.globalCompositeOperation = 'lighter'; A.globalAlpha = .35;
    A.drawImage(_bloomB, -1.6, 0, bw, bh);
    A.drawImage(_bloomB, 1.6, 0, bw, bh);
    A.drawImage(_bloomB, 0, -1.6, bw, bh);
    A.drawImage(_bloomB, 0, 1.6, bw, bh);
    ctx2d.globalCompositeOperation = 'lighter';
    ctx2d.globalAlpha = strength;
    ctx2d.drawImage(_bloomA, 0, 0, bw, bh, 0, 0, W, H);
    ctx2d.globalAlpha = 1;
    ctx2d.globalCompositeOperation = 'source-over';
  }
  function bloomPass(W, H, strength){
    if(!ctx2d || strength <= 0) return;
    if(!bloomA){ bloomA = document.createElement('canvas'); bloomB = document.createElement('canvas'); }
    var w4 = Math.max(1, W >> 2), h4 = Math.max(1, H >> 2);
    var w8 = Math.max(1, W >> 3), h8 = Math.max(1, H >> 3);
    if(bloomA.width !== w4 || bloomA.height !== h4){ bloomA.width = w4; bloomA.height = h4; }
    if(bloomB.width !== w8 || bloomB.height !== h8){ bloomB.width = w8; bloomB.height = h8; }
    var a = bloomA.getContext('2d'), b = bloomB.getContext('2d');
    a.globalCompositeOperation = 'source-over';
    a.clearRect(0, 0, w4, h4);
    a.drawImage(canvas, 0, 0, w4, h4);
    a.globalCompositeOperation = 'lighter';     /* 自叠一次：软阈值，只让亮部继续亮 */
    a.globalAlpha = 0.85; a.drawImage(bloomA, 0, 0, w4, h4); a.globalAlpha = 1;
    b.globalCompositeOperation = 'source-over';
    b.clearRect(0, 0, w8, h8);
    b.drawImage(bloomA, 0, 0, w8, h8);
    b.globalCompositeOperation = 'lighter';
    b.globalAlpha = 0.9; b.drawImage(bloomB, 0, 0, w8, h8); b.globalAlpha = 1;
    ctx2d.globalCompositeOperation = 'lighter';
    ctx2d.globalAlpha = strength * 0.55;
    ctx2d.drawImage(bloomB, 0, 0, W, H);
    ctx2d.globalAlpha = strength;
    ctx2d.drawImage(bloomA, 0, 0, W, H);
    ctx2d.globalAlpha = 1;
    ctx2d.globalCompositeOperation = 'source-over';
  }

  /* ---- 复用池：候选星不再每帧新建 9 万个数组对象（原来每秒几十万个垃圾，必然卡顿发抖） ---- */
  var bigPool = [], bigList = [], bigN = 0;
  var _histBuf = new Int32Array(64);       /* 分数直方图：用来 O(n) 选阈值，替代每帧全量排序 */
  function poolGet(){
    var a = bigPool[bigN];
    if(!a){ a = bigPool[bigN] = [0, 0, 0, 0, null, 0, 0, 0, 0, 0]; }
    bigN++;
    return a;
  }
  /* 星云精灵：噪声 + 颜色，缓存按 主题/序号 */
  var nebSprites = {}, nebNoise = {};
  function noiseSprite(seed){
    var k = 'n' + Math.round(seed * 977);
    if(nebNoise[k]) return nebNoise[k];
    /* 大改：160→320，与 nebSprite 画布同尺寸（否则 320 画布只被噪声填满左上 1/4 象限）。
       实测 8 张生成 98ms→306ms（一次性、之后缓存），换来云团原生 2 倍分辨率。 */
    var S = 320, c = document.createElement('canvas'); c.width = c.height = S;
    var x = c.getContext('2d');
    var img = x.createImageData(S, S), d = img.data;
    function hash2(px, py){ var h = Math.sin(px * 127.1 + py * 311.7 + seed * 13.7) * 43758.5453; return h - Math.floor(h); }
    function vnoise(px, py){
      var xi = Math.floor(px), yi = Math.floor(py), xf = px - xi, yf = py - yi;
      var u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
      return (hash2(xi, yi) * (1 - u) + hash2(xi + 1, yi) * u) * (1 - v) + (hash2(xi, yi + 1) * (1 - u) + hash2(xi + 1, yi + 1) * u) * v;
    }
    function fbm(px, py){ var v = 0, a = 0.55, f = 1; for(var i = 0; i < 4; i++){ v += a * vnoise(px * f, py * f); f *= 2.03; a *= 0.5; } return v; }
    for(var y = 0; y < S; y++){
      for(var xx = 0; xx < S; xx++){
        var u2 = xx / S * 2 - 1, v2 = y / S * 2 - 1, m = Math.sqrt(u2*u2 + v2*v2);
        var soft = Math.max(0, Math.min(1, 1 - m)); soft = soft * soft * (3 - 2 * soft);
        var n = fbm(xx / S * 3.6, y / S * 3.6) * 0.95 + fbm(xx / S * 8.6 + 3.3, y / S * 8.6) * 0.5;
        var al = Math.max(0, Math.min(1, soft * Math.pow(n, 2.1) * 1.4));
        var idx = (y * S + xx) * 4;
        d[idx] = 255; d[idx+1] = 255; d[idx+2] = 255; d[idx+3] = Math.round(al * 255);
      }
    }
    x.putImageData(img, 0, 0);
    nebNoise[k] = c;
    return c;
  }
  function nebSprite(col, seed, key, col2){
    var kk = colKey(col) + '_' + (col2 ? colKey(col2) : '') + '_' + Math.round(seed * 977);
    if(nebSprites[kk]) return nebSprites[kk];
    /* 2x：160→320。云团精灵 2x，配合渲染系数 320 已基本是 1:1，告别棉絮 */
    var S = 320, c = document.createElement('canvas'); c.width = c.height = S;
    var x = c.getContext('2d');
    x.drawImage(noiseSprite(seed), 0, 0);
    var gr = x.createLinearGradient(0, 0, 0, S);
    gr.addColorStop(0, 'rgb(' + Math.round(col[0]*255) + ',' + Math.round(col[1]*255) + ',' + Math.round(col[2]*255) + ')');
    var c2b = col2 || col;
    gr.addColorStop(1, 'rgb(' + Math.round(c2b[0]*255) + ',' + Math.round(c2b[1]*255) + ',' + Math.round(c2b[2]*255) + ')');
    x.globalCompositeOperation = 'source-in';
    x.fillStyle = gr; x.fillRect(0, 0, S, S);
    x.globalCompositeOperation = 'source-over';
    nebSprites[kk] = c;
    return c;
  }
  function nebSpriteUnused(col, seed, key, col2){
    var S = 160, c = document.createElement('canvas'); c.width = c.height = S;
    var x = c.getContext('2d');
    var img = x.createImageData(S, S), d = img.data;
    function hash2(px, py){ var h = Math.sin(px * 127.1 + py * 311.7 + seed * 13.7) * 43758.5453; return h - Math.floor(h); }
    function vnoise(px, py){
      var xi = Math.floor(px), yi = Math.floor(py), xf = px - xi, yf = py - yi;
      var u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
      return (hash2(xi, yi) * (1 - u) + hash2(xi + 1, yi) * u) * (1 - v) + (hash2(xi, yi + 1) * (1 - u) + hash2(xi + 1, yi + 1) * u) * v;
    }
    function fbm(px, py){ var v = 0, a = 0.55, f = 1; for(var i = 0; i < 5; i++){ v += a * vnoise(px * f, py * f); f *= 2.03; a *= 0.5; } return v; }
    var R = Math.round(col[0]*255), G = Math.round(col[1]*255), B = Math.round(col[2]*255);
    var c2 = col2 || col;
    var R2 = Math.round(c2[0]*255), G2 = Math.round(c2[1]*255), B2 = Math.round(c2[2]*255);
    for(var y = 0; y < S; y++){
      var grad = y / S;                       /* 上下双色，做出体积感 */
      var rr = Math.round(R + (R2 - R) * grad), gg = Math.round(G + (G2 - G) * grad), bb = Math.round(B + (B2 - B) * grad);
      for(var xx = 0; xx < S; xx++){
        var u2 = xx / S * 2 - 1, v2 = y / S * 2 - 1, m = Math.sqrt(u2*u2 + v2*v2);
        var soft = Math.max(0, Math.min(1, 1 - m));
        soft = soft * soft * (3 - 2 * soft);
        var n = fbm(xx / S * 3.6, y / S * 3.6) * 0.95 + fbm(xx / S * 8.6 + 3.3, y / S * 8.6) * 0.5 + fbm(xx / S * 17 + 7.1, y / S * 17) * 0.22;
        var al = Math.max(0, Math.min(1, soft * Math.pow(n, 2.1) * 1.35));
        var idx = (y * S + xx) * 4;
        d[idx] = rr; d[idx+1] = gg; d[idx+2] = bb; d[idx+3] = Math.round(al * 255);
      }
    }
    x.putImageData(img, 0, 0);
    nebSprites[key] = c;
    return c;
  }
  function bindInput2D(){
    if(canvas.__star2dBound) return;
    canvas.__star2dBound = 1;
    var down = null, pt = {};
    canvas.addEventListener('pointerdown', function(e){
      lastUserAt = performance.now();          /* 用户接管：暂时停掉自走镜头 */
      pt[e.pointerId] = { x: e.clientX, y: e.clientY };
      try{ canvas.setPointerCapture(e.pointerId); }catch(x){}
      if(Object.keys(pt).length === 1){ down = { x: e.clientX, y: e.clientY, t: performance.now(), moved: 0 }; }
      // 复用心跳：直接调用共享逻辑不可行，这里做简化版
      window.__star2DPtr = pt;
      if(!drag) drag = { x: e.clientX, y: e.clientY, t: performance.now() };
      moved = 0; downAt = performance.now();
    });
    canvas.addEventListener('pointermove', function(e){
      if(!pt[e.pointerId]) return;
      lastUserAt = performance.now();
      var prev = pt[e.pointerId];
      var ids = Object.keys(pt);
      if(ids.length === 1 && down){
        var dx = e.clientX - prev.x, dy = e.clientY - prev.y;
        moved += Math.hypot(dx, dy);
        yaw -= dx * 0.0052; pitch = Math.max(-1.25, Math.min(1.25, pitch + dy * 0.0042));
        vYaw = -dx * 0.0022; vPitch = dy * 0.0016;
        if(moved > 6 && fx.pos){ var wp = worldFromScreen(e.clientX, e.clientY); trail(wp); }
      } else if(ids.length >= 2){
        var id0 = ids[0], id1 = ids[1];
        var a = pt[id0], b = pt[id1];
        var cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
        var dPrev = Math.hypot(a.x - b.x, a.y - b.y);
        pt[e.pointerId] = { x: e.clientX, y: e.clientY };
        a = pt[id0]; b = pt[id1];
        var cx2 = (a.x + b.x) / 2, cy2 = (a.y + b.y) / 2;
        var dNow = Math.hypot(a.x - b.x, a.y - b.y);
        var eye = camEye(), fwd = [target[0]-eye[0], target[1]-eye[1], target[2]-eye[2]];
        var fl = Math.hypot(fwd[0],fwd[1],fwd[2]) || 1; fwd = [fwd[0]/fl, fwd[1]/fl, fwd[2]/fl];
        var right = [fwd[2], 0, -fwd[0]]; var rl = Math.hypot(right[0], right[2]) || 1; right = [right[0]/rl, 0, right[2]/rl];
        var panScale = dist * 0.0016;
        var mdx = (cx2 - cx) * panScale, mdy = (cy2 - cy) * panScale;
        target[0] -= right[0]*mdx; target[1] += mdy; target[2] -= right[2]*mdx;
        if(dPrev > 8 && dNow > 8) dist = Math.max(24, Math.min(700, dist * (dPrev / dNow)));
      }
      pt[e.pointerId] = { x: e.clientX, y: e.clientY };
    });
    function up(e){
      if(!pt[e.pointerId]) return;
      delete pt[e.pointerId];
      var dur = performance.now() - downAt;
      if(down && moved < 10 && dur < 420){ var wp2 = worldFromScreen(e.clientX, e.clientY); ripple(wp2, false); tapMemory(e.clientX, e.clientY); }
      if(Object.keys(pt).length === 0){ down = null; drag = null; }
    }
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);
  }
  function projStar(x, y, z, view, proj, W, H){
    var vx = view[0]*x + view[4]*y + view[8]*z + view[12];
    var vy = view[1]*x + view[5]*y + view[9]*z + view[13];
    var vz = view[2]*x + view[6]*y + view[10]*z + view[14];
    if(vz > -2) return null;
    var cx = proj[0]*vx + proj[8]*vz, cy = proj[5]*vy + proj[9]*vz, cw = -vz;
    return [ (cx / cw * 0.5 + 0.5) * W, (1 - (cy / cw * 0.5 + 0.5)) * H, cw ];
  }
  var quietMotion = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  function drawQuietDay(t,W,H){
    /* 减少动态时减速而不是冻结：冻住会让人以为坏了（海水一动不动） */
    if(quietMotion && quietMotion.matches) t*=0.6;
    var x=ctx2d, horizon=H*.56;
    /* ① 天空：上淡蓝 → 中乳白 → 地平线暖金。
       以前是一条灰蓝到灰绿的渐变，整页发闷 —— 这是"白天不好看"的主因。 */
    var sky=x.createLinearGradient(0,0,0,horizon+2);
    sky.addColorStop(0,'#8ab2d2');
    sky.addColorStop(0.34,'#bdd5e3');
    sky.addColorStop(0.66,'#e8e4d6');
    sky.addColorStop(0.88,'#f7e4c4');
    sky.addColorStop(1,'#fcecd0');
    x.fillStyle=sky; x.fillRect(0,0,W,horizon+2);

    /* ② 低垂的太阳：只发光，不画硬边圆盘 */
    var sunX=W*(0.66+0.02*Math.sin(t*0.03)), sunY=horizon-H*0.20;
    var sg=x.createRadialGradient(sunX,sunY,0,sunX,sunY,H*0.46);
    sg.addColorStop(0,'rgba(255,248,226,.95)');
    sg.addColorStop(0.10,'rgba(255,240,200,.58)');
    sg.addColorStop(0.34,'rgba(255,228,180,.20)');
    sg.addColorStop(1,'rgba(255,222,172,0)');
    x.fillStyle=sg; x.beginPath(); x.arc(sunX,sunY,H*0.46,0,6.2832); x.fill();
    x.beginPath(); x.arc(sunX,sunY,Math.min(W,H)*0.034,0,6.2832);
    x.fillStyle='rgba(255,253,246,.96)'; x.fill();

    /* ③ 云：层云带弧，顶上被太阳照亮、底下偏一点点粉，
       不再是七团"糊在一起的灰棉花" */
    for(var j=0;j<9;j++){
      var cx=W*(0.10+j*0.115)+Math.sin(t*0.016+j*1.7)*W*0.05;
      var cy=H*(0.16+0.075*(j%4))+H*0.02*Math.sin(j*2.3);
      var near=Math.max(0,1-Math.abs(cx-sunX)/(W*0.55));
      x.save(); x.translate(cx,cy); x.scale(1,0.24);
      var r=W*(0.40+0.10*Math.sin(j*1.3));
      var cloud=x.createRadialGradient(0,0,0,0,0,r);
      cloud.addColorStop(0,'rgba(255,252,246,'+(0.20+0.16*near).toFixed(3)+')');
      cloud.addColorStop(0.45,'rgba(252,240,232,'+(0.11+0.10*near).toFixed(3)+')');
      cloud.addColorStop(1,'rgba(250,236,230,0)');
      x.fillStyle=cloud; x.fillRect(-r,-r,r*2,r*2);
      x.restore();
    }

    /* ⑤ 海：上浅下深。顶部直接接天空的地平线色，否则天海之间会有一条硬边 */
    var sea=x.createLinearGradient(0,horizon,0,H);
    sea.addColorStop(0,'#f3e6cd');
    sea.addColorStop(0.045,'#d9d6c4');
    sea.addColorStop(0.14,'#a6bfc2');
    sea.addColorStop(0.45,'#6d97ad');
    sea.addColorStop(1,'#3a6a89');
    x.fillStyle=sea; x.fillRect(0,horizon,W,H-horizon);

    /* ⑥ 地平线暖雾：盖在海天交界上，把那条边彻底化开 */
    var mist=x.createLinearGradient(0,horizon-H*.12,0,horizon+H*.16);
    mist.addColorStop(0,'rgba(255,242,218,0)');
    mist.addColorStop(.40,'rgba(255,243,222,.40)');
    mist.addColorStop(.55,'rgba(255,244,226,.46)');
    mist.addColorStop(1,'rgba(226,236,238,0)');
    x.fillStyle=mist; x.fillRect(0,horizon-H*.12,W,H*.28);

    /* ⑦ 太阳在水面的光路：一条会碎、会晃的金色带子（白天最出彩的一笔） */
    for(var row0=0; row0<52; row0++){
      var z0=(row0+.5)/52, yy0=horizon+Math.pow(z0,1.55)*(H-horizon);
      var spread=W*(0.018+z0*0.10)*(0.72+0.28*Math.abs(Math.sin(t*0.6+row0*1.1)));
      var aa=(1-z0*0.75)*(0.35+0.65*Math.abs(Math.sin(t*(1.05+z0*0.9)+row0*1.9)));
      var lg=x.createLinearGradient(sunX-spread,0,sunX+spread,0);
      lg.addColorStop(0,'rgba(255,238,196,0)');
      lg.addColorStop(0.5,'rgba(255,246,216,'+(0.46*aa).toFixed(3)+')');
      lg.addColorStop(1,'rgba(255,238,196,0)');
      x.fillStyle=lg;
      var hh=Math.max(1,(1.0+z0*1.7)*DPR);
      x.fillRect(sunX-spread,yy0,spread*2,hh);
    }

    /* ⑧ 细浪 + 碎光：保留原来那套行波，颜色调暖一点 */
    x.lineCap='round';
    for(var row=0;row<42;row++){
      var z=(row+.5)/42, yy=horizon+Math.pow(z,1.7)*(H-horizon);
      x.lineWidth=(.35+z*.55)*DPR;
      x.strokeStyle='rgba(36,78,102,'+(.030+z*.055).toFixed(3)+')';x.beginPath();
      for(var k=0;k<=32;k++){
        var xx=k/32*W;
        var y=yy+Math.sin(k*.38+t*(1.05+z*.55)+row*1.73)*(.25+z*2.5)*DPR;
        if(k===0)x.moveTo(xx,y);else x.lineTo(xx,y);
      }x.stroke();
      var center=W*(.64+Math.sin(row*12.3)*.14)+Math.sin(t*(.55+z*.45)+row*1.3)*W*.016;
      var len=W*(.012+z*.045)*(0.7+0.5*Math.abs(Math.sin(t*(.8+z*.6)+row*2.1)));
      var shim=0.45+0.55*Math.sin(t*(1.6+z*.9)+row*2.7);
      x.strokeStyle='rgba(255,248,226,'+((.05+z*.075)*Math.max(.15,shim)).toFixed(3)+')';
      x.beginPath();x.moveTo(center-len,yy+2*DPR);x.lineTo(center+len,yy+2*DPR);x.stroke();
    }
  }
  function render2D(t){
    /* 减少动态 = 放慢，不是清零。原来把整页时间归零，整个星海变成一张静止图片 */
    if(quietMotion && quietMotion.matches) t*=0.55;
    if(!ctx2d) return;
    var interacting = (performance.now() - lastUserAt) < 350;
    var _dpr2dCap = Math.min(_rawDpr, 2.5);
    if(interacting && DPR > 1.4) DPR = 1.4;
    else if(!interacting && DPR < _dpr2dCap) DPR = _dpr2dCap;
    /* 兜底：上一帧若在白天分支里异常中断，先还原镜头距离与画布变换 */
    if(_dayFrozen){ dist = _dayFrozenDist; _dayFrozen = 0; ctx2d.setTransform(1, 0, 0, 1, 0, 0); }
    var w = canvas.clientWidth || 1, h = canvas.clientHeight || 1;
    var pw = Math.max(1, Math.round(w * DPR)), ph = Math.max(1, Math.round(h * DPR));
    if(canvas.width !== pw || canvas.height !== ph){ canvas.width = pw; canvas.height = ph; }
    var W = canvas.width, H = canvas.height;
    var aspect = W / Math.max(1, H);
    var day = modeT <= 0.5;
    /* 白天不再另搞一套：和夜间走同一条路径、同一个镜头与缩放，
       只是配色不同。之前那些"把船钉在水面行""限制缩放范围"的特殊处理全部拆掉，
       因为正是它们让白天看着像贴图、手感也和夜间对不上。 */
    var proj = perspective(52 * Math.PI / 180, aspect, 1, 2200);
    var eye = camEye();
    var view = lookAt(eye, target, [0, 1, 0]);
    var bg = day ? dayPalette().bg : palette.bg;
    ctx2d.globalCompositeOperation = 'source-over';
    ctx2d.globalAlpha = 1;
    ctx2d.imageSmoothingEnabled = true;
    if(day){
      drawQuietDay(t, W, H);
    } else {
      var gn = ctx2d.createLinearGradient(0,0,W,H);
      gn.addColorStop(0,'#0c1a2c');
      gn.addColorStop(.55,'#132741');
      gn.addColorStop(1,'#0d1c30');
      ctx2d.fillStyle=gn; ctx2d.fillRect(0,0,W,H);
      /* 极淡的银河带：沿对角线铺一道低饱和暖光，比纯色背景多一层"夜空"的厚度
         （0.08 透明度刚刚好能看出方向，又不会把星压暗） */
      var gb = ctx2d.createLinearGradient(0, H*0.62, W, H*0.32);
      gb.addColorStop(0,   'rgba(200,180,210,0)');
      gb.addColorStop(0.5, 'rgba(230,200,220,0.10)');
      gb.addColorStop(1,   'rgba(200,180,210,0)');
      ctx2d.fillStyle = gb; ctx2d.fillRect(0,0,W,H);
    }

    /* 自转表：云、星、尘带共用同一张表，保证整片海是同一个刚体图案在转 */
    spinTable(t);

    /* 云团：跟着银盘一起公转，同时各自缓慢自转 + 呼吸 */
    ctx2d.globalCompositeOperation = day ? 'source-over' : 'lighter';
    var nebMap = { nebA: palette.nebA, nebB: palette.nebB };
    for(var i = 0; !day && i < nebulas.length; i++){
      if(interacting && (i & 1)) continue;
      var nb = nebulas[i];
      var nbB = spinBucketAt(nb.c[0], nb.c[2]);
      var nbx = nb.c[0] * _ca[nbB] - nb.c[2] * _sa[nbB];
      var nbz = nb.c[0] * _sa[nbB] + nb.c[2] * _ca[nbB];
      var p = projStar(nbx, nb.c[1], nbz, view, proj, W, H);
      if(!p) continue;
      var tint = nebMap[nb.tint] || palette.nebA;
      var breath = 1 + 0.10 * Math.sin(t * nb.pulseSpd + nb.pulsePh);
      /* 主云团缩放：620→320。之前 160px 噪声图被拉到 ~620px 整片棉絮，
         现在 320px 上限（2× 缩放），配合新 DPR 看着锐、有结构。 */
      var rad = nb.size * breath * (320 / Math.max(60, p[2])) * DPR;
      if(rad > NEB_RAD_MAX) rad = NEB_RAD_MAX;
      if(rad < 8) continue;
      var tint2 = nebMap[nb.tint === 'nebA' ? 'nebB' : 'nebA'] || tint;
      var spr = nebSprite(tint, nb.seed[0], 'n' + Math.round(nb.seed[0] * 97) + '_' + Math.round(tint[0]*255) + '_' + Math.round(tint2[0]*255), tint2);
      ctx2d.save();
      ctx2d.translate(p[0], p[1]);
      ctx2d.rotate(nb.rot + t * nb.rotSpd);
      ctx2d.globalAlpha = nb.a * 0.95 * (1 + 0.14 * Math.sin(t * nb.pulseSpd * 1.6 + nb.pulsePh));
      ctx2d.drawImage(spr, -rad, -rad, rad * 2, rad * 2);
      ctx2d.restore();
    }
    ctx2d.globalAlpha = 1;

    /* 银河带整体辉光：压扁拉长的云精灵沿带铺几条，跟着盘一起转、一起明灭 */
    if(!day && !interacting && window.TE_STAR_QUALITY !== 'low'){
      ctx2d.globalCompositeOperation = day ? 'source-over' : 'lighter';
      var bandTint = palette.nebA;
      var bandSpr = nebSprite(bandTint, 7.7, 'band_' + Math.round(bandTint[0]*255) + '_' + Math.round(bandTint[1]*255) + '_' + Math.round(bandTint[2]*255));
      for(var bi = 0; bi < 7; bi++){
        var bAng = bi / 7 * Math.PI * 2;
        var bxx = Math.cos(bAng) * 120, bzz = Math.sin(bAng) * 120;
        var bbk = spinBucketAt(bxx, bzz);
        var bp = projStar(bxx * _ca[bbk] - bzz * _sa[bbk], 0, bxx * _sa[bbk] + bzz * _ca[bbk], view, proj, W, H);
        if(!bp) continue;
        var brad = Math.min(W*.8, 150 * (220 / Math.max(100, bp[2])) * DPR);
        ctx2d.save();
        ctx2d.translate(bp[0], bp[1]);
        ctx2d.rotate(Math.atan2(bp[1] - H * 0.5, bp[0] - W * 0.5) + Math.PI / 2);
        ctx2d.scale(3.4, 0.55);
        ctx2d.globalAlpha = (day ? 0 : 0.17) * (1 + 0.10 * Math.sin(t * 0.13 + bi));
        ctx2d.drawImage(bandSpr, -brad, -brad, brad * 2, brad * 2);
        ctx2d.restore();
      }
      ctx2d.globalAlpha = 1;
    }

    /* Stable fine stars; daylight only renders memory anchors. */
    ctx2d.globalCompositeOperation = day ? 'source-over' : 'lighter';
    var _eye = camEye(), _b = camBasis();
    var _K = (H * 0.5) / Math.tan(26 * Math.PI / 180);
    var _hw = W * 0.5, _hh = H * 0.5;
    var _fw = _b.fwd, _rt = _b.right, _up = _b.up;
    var sets = [dust, swarm, near, halo, galaxy, memStars];   /* 白天同样要有星海，只是画法不同 */
    bigList.length = 0; bigN = 0;
    for(var si = 0; si < sets.length; si++){
      var st = sets[si]; if(!st || !st.pos) continue;
      var setSeed = (si + 1) * 7919;
      var sPos = st.pos, sCol = st.col, sSiz = st.siz, sBkt = st.bkt, sExt = st.ext;
      for(var k = 0; k < st.count; k++){
        /* 固定抽样号配合柔和边界，性能降档时逐渐隐去，避免整批星点跳闪。 */
        var _bud = interacting ? Math.min(drawBudget, 2600) : drawBudget;
        var density = Math.min(.42, _bud / 22000);
        var sample = h01(k, setSeed + 31337);
        var densityFade = st === memStars ? 1 : Math.max(0, Math.min(1, (density - sample) / .018));
        if(densityFade <= 0) continue;
        densityFade = densityFade * densityFade * (3 - 2 * densityFade);
        var wx = sPos[k*3], wy = sPos[k*3+1], wz = sPos[k*3+2];
        var bk = sBkt ? sBkt[k] : 0;                     /* 分桶自转：查表，不做三角函数 */
        var rx = wx * _ca[bk] - wz * _sa[bk], rz = wx * _sa[bk] + wz * _ca[bk];
        var _dx = rx - _eye[0], _dy = wy - _eye[1], _dz = rz - _eye[2];
        var vz = _dx*_fw[0] + _dy*_fw[1] + _dz*_fw[2];
        if(vz < 3) continue;
        var _vx = _dx*_rt[0] + _dy*_rt[1] + _dz*_rt[2];
        var _vy = _dx*_up[0] + _dy*_up[1] + _dz*_up[2];
        var pp0 = _hw + _vx * _K / vz, pp1 = _hh - _vy * _K / vz;
        if(pp0 < -40 || pp0 > W + 40 || pp1 < -40 || pp1 > H + 40) continue;
        var kind = sCol[k*4] | 0, br = sCol[k*4+1];
        /* 每颗星固定不变的"随机数"：色温档 / 星等 / 闪烁速率 */
        var hv = h01(k, setSeed), hm = h01(k, setSeed + 104729), hf = h01(k, setSeed + 224737);
        var vi = (hv * 5) | 0;
        /* 星等分布：多数星很暗、少数很亮（三次方压低，符合真实星场） */
        var mag = hm * hm * (0.55 + 0.45 * hm);
        var ext = sExt ? sExt[k] : 0;
        var exLv = ext > 0.62 ? 3 : ext > 0.38 ? 2 : ext > 0.16 ? 1 : 0;
        var c = starTint(kind, vi, exLv);
        /* 闪烁：亮星稳、暗星抖（真实观测里暗星受视宁度影响更大） */
        var tw = 1 - (0.55 + 0.45 * (1 - mag)) * 0.15 * (0.5 + 0.5 * Math.sin(t * (0.9 + hf * 2.4) + hf * 6.2831));
        var alpha = (kind === 0 ? .98 : kind === 1 ? .86 : kind === 2 ? .62 : .95) * (0.62 + br * 0.38);
        alpha *= (1 - ext * 0.72) * tw * STAR_GAIN;      /* 尘埃遮挡 + 总增益 */
        /* 尺寸与亮度都走幂律：绝大多数是暗弱小点，极少数才是显眼亮星。
           上一版把两者压得太扁（绘制时 alpha 还被卡在 0.48），整片星海没有一个亮点 —— 那才是"更丑"的原因。 */
        var shape = Math.pow(hm, 2.9);
        var lum = Math.pow(hm, 4.2);
        /* 屏幕光斑保留可读下限，同时随深度连续变化；近星不膨胀成白斑。 */
        var depthScale = Math.max(.72, Math.min(1.65, Math.pow(180 / Math.max(30, vz), .32)));
        var size = DPR * (st === memStars ? 2.4 : .52 + shape * 3.6) * depthScale;
        alpha *= (st === memStars ? .90 : .12 + lum * 1.25) * densityFade;
        if(day){
          /* 白天不是把夜星调暗，而是换一种存在方式：浅色微光点浮在雾蓝天空上 */
          c = [.97, .99, 1.0];
          alpha = Math.min(alpha, .64);
          size *= .86;
        }
        var fog = Math.max(0.70, Math.min(1, 1 - (vz - 200) / 2400));   /* 原来压到 0.45，远处亮星全被闷死 */
        alpha *= fog;
        var score = size * alpha;                        /* 够大够亮才配上屏 */
        if(st !== memStars && score < 0.025) continue;                       /* 只丢掉真正看不见的；留足小星，星尘质感靠它们 */
        var it = poolGet();
        it[0] = vz; it[1] = pp0; it[2] = pp1; it[3] = size; it[4] = c;
        it[5] = alpha; it[6] = score; it[7] = mag; it[8] = exLv;
        it[9] = h01(k, setSeed + 31337);                 /* 固定抽签号：第二梯队靠它补位 */
        bigList.push(it);
      }
    }
    // Candidate size and luminance already follow a stable distribution.
    // Memory stars never compete with decorative stars for a draw budget.
    var poolN = bigList.length;
    _lastPoolN = poolN; _lastDrawnN = poolN;
    /* 夜色用加法混合：星与星、星与银河会互相叠亮，才有"透"的感觉；
       白天换回 source-over，否则整片天空会被加爆 */
    ctx2d.globalCompositeOperation = day ? 'source-over' : 'lighter';
    var haloBudget = day ? 26 : (interacting ? 32 : 78);
    /* 柔光层：只给最亮的几十颗配光晕会让整片星海显得干、薄 */
    var glowBudget = day ? 0 : (interacting ? 130 : 320);
    var spikeBudget = day ? 0 : Math.round((interacting ? 10 : 26) * SPIKE_GAIN);
    var bloomList = _bloomList; bloomList.length = 0;
    /* ★ 星点绘制期间关闭双线性插值 —— 之前 smoothing 让 48px sprite 缩到 6px 全糊掉 */
    var _smoothingPrev = ctx2d.imageSmoothingEnabled;
    ctx2d.imageSmoothingEnabled = false;
    for(var q = 0; q < poolN; q++){
      var it2 = bigList[q];
      var sz = Math.min(9, it2[3]);
      var a2 = Math.min(day ? .50 : .95, it2[5]);
      var d1 = sz * 2.1;
      ctx2d.globalAlpha = a2;
      ctx2d.drawImage(starDot(it2[4]), it2[1] - d1/2, it2[2] - d1/2, d1, d1);
      /* ★★ 硬核 fillRect：每颗星都加 1/1.5/2px 白色实心点。
         之前所有星都靠 sprite 软渐变，远看就是棉絮；
         这层实心点是"针尖星"的关键，叠加在 sprite 之上立刻锐利。 */
      var cs = sz < 1.8 ? 1 : (sz < 3.2 ? 1.5 : 2);
      ctx2d.fillStyle = '#ffffff';
      ctx2d.globalAlpha = Math.min(1, a2 * (sz < 1.8 ? 1.1 : 0.95));
      ctx2d.fillRect(it2[1] - cs/2, it2[2] - cs/2, cs, cs);
      /* 亮星的核心要真的烧起来：加一颗可见的白色过曝核。
         原来精灵里的高光只有 8.5% 半径，在十几像素的星点上还不到一个像素，
         所以全画面最亮也只到 173 —— 整片星海显得发闷、没精神。
         真实相机里亮星核心本来就过曝成白，这样才对。 */
      if(a2 > .74 && sz > 2.6){
        var dc = Math.max(2.8, d1 * .44);
        ctx2d.globalAlpha = Math.min(.98, (a2 - .42) * 1.8);
        ctx2d.drawImage(starCore([1, 1, 1]), it2[1] - dc/2, it2[2] - dc/2, dc, dc);
      }
      /* 收紧：halo/spike/bloom 全部门槛抬高、半径缩小，对付"好亮" */
      if(a2 > .78 && sz > 2.6){
        if(haloBudget > 0){
          haloBudget--;
          /* halo 半径 1.8→1.3：再缩一档，亮星更"针尖" */
          var d3 = d1 * 1.3;
          ctx2d.globalAlpha = a2 * .24;
          ctx2d.drawImage(starSprite(it2[4]), it2[1] - d3/2, it2[2] - d3/2, d3, d3);
        }
        /* 星芒保持：只给最亮的 5% 出尖十字 */
        if(spikeBudget > 0 && a2 > .84 && sz > 3.4){
          spikeBudget--;
          var d4 = d1 * 6.0;
          ctx2d.globalAlpha = Math.min(.55, a2 * .55);
          ctx2d.drawImage(sparkSprite(1), it2[1] - d4/2, it2[2] - d4/2, d4, d4);
        }
        /* bloomList 门槛：.70→.88，只收最亮的 2-3%（之前 750 颗里有大半是中心那条带的"普通亮星"） */
        if(a2 > .88 && bloomList.length < 400) bloomList.push(it2[1], it2[2], d1, a2, it2[4]);
      }
      if(glowBudget > 0 && a2 > .55 && sz > 1.8){
        glowBudget--;
        /* glow 半径 3.4→2.2 */
        var d5 = d1 * 2.2;
        ctx2d.globalAlpha = Math.min(.14, a2 * .12);
        ctx2d.drawImage(starSprite(it2[4]), it2[1] - d5/2, it2[2] - d5/2, d5, d5);
      }
    }
    ctx2d.imageSmoothingEnabled = _smoothingPrev;
    ctx2d.globalAlpha = 1;

    /* 暗尘带：压在星点之上，用 multiply 真正"挡"住后面的星光（明暗相间的层次感）
       只画夜色；白天是亮天空，压暗会显得脏 */
    if(!day && dustLanes.length){
      ctx2d.globalCompositeOperation = 'multiply';
      if(ctx2d.globalCompositeOperation === 'multiply'){   /* 不支持就整段跳过，别硬画成黑块 */
        for(var di = 0; di < dustLanes.length; di++){
          var dl = dustLanes[di];
          var dlB = spinBucketAt(dl.c[0], dl.c[2]);
          var dlx = dl.c[0] * _ca[dlB] - dl.c[2] * _sa[dlB];
          var dlz = dl.c[0] * _sa[dlB] + dl.c[2] * _ca[dlB];
          var dp = projStar(dlx, dl.c[1], dlz, view, proj, W, H);
          if(!dp) continue;
          /* ★ 云团缩放：620→380。之前 160px 噪声图被拉到 ~620px 糊成棉絮，
             现在 380px 上限（≈2.4× 缩放，仍有结构感），配合更高的 DPR 看着更锐。 */
          var drad = dl.size * (380 / Math.max(60, dp[2])) * DPR;
          if(drad > NEB_RAD_MAX) drad = NEB_RAD_MAX;
          if(drad < 10) continue;
          var dspr = nebSprite(DUST_TINT, dl.seed[0], 'dust_' + Math.round(dl.seed[0] * 97));
          ctx2d.save();
          ctx2d.translate(dp[0], dp[1]);
          ctx2d.rotate(dl.rot + t * dl.rotSpd);
          ctx2d.globalAlpha = dl.a * 1.15 * (0.75 + 0.25 * Math.sin(t * dl.pulseSpd + dl.pulsePh));
          ctx2d.drawImage(dspr, -drad, -drad, drad * 2, drad * 2);
          ctx2d.restore();
        }
      }
      ctx2d.globalAlpha = 1;
      ctx2d.globalCompositeOperation = 'source-over';
    }
    /* 暗角：让中心更亮、边缘更沉，提升光影层次 */
    if(!day){
      var vg = ctx2d.createRadialGradient(W / 2, H * 0.46, Math.min(W, H) * 0.22, W / 2, H * 0.5, Math.max(W, H) * 0.78);
      vg.addColorStop(0, 'rgba(0,0,0,0)');
      vg.addColorStop(0.55, 'rgba(0,0,0,.12)');
      vg.addColorStop(0.82, 'rgba(0,0,0,.26)');
      vg.addColorStop(1, 'rgba(0,0,0,.42)');
      ctx2d.globalCompositeOperation = 'source-over';
      ctx2d.fillStyle = vg;
      ctx2d.fillRect(0, 0, W, H);
    }

    /* 星球 & 星芒点缀 */
    drawPlanets2D(t, view, proj, W, H, day);

    /* 海上漂浮物：流星 / 小船 / 漂流瓶 */
    var _dt = (t - _lastT) > 0 && (t - _lastT) < 0.5 ? (t - _lastT) : 0.016;
    _lastT = t;
    drawFloat2D(t, _dt, view, proj, W, H, day);

    /* 光线：多层发光 + 沿线流动的亮点（之前整段被删掉，数据还在白生成） */
    if(rays && rays.length){
      ctx2d.globalCompositeOperation = day ? 'source-over' : 'lighter';
      ctx2d.lineCap = 'round';
      var rc = palette.ray;
      var colStr = Math.round(rc[0]*255) + ',' + Math.round(rc[1]*255) + ',' + Math.round(rc[2]*255);
      for(var ri = 0; ri < rays.length; ri++){
        var ry = rays[ri], flow = (t * ry.speed + ry.phase) % 1;
        var scr = [];
        for(var k2 = 0; k2 < ry.pts.length; k2++){
          var q2 = ry.pts[k2];
          scr.push(projStar(q2[0], q2[1], q2[2], view, proj, W, H));
        }
        var passes = [[2.0, 0.016], [1.0, 0.030], [0.6, 0.062]];
        for(var pi = 0; pi < passes.length; pi++){
          ctx2d.beginPath();
          var started = false;
          for(var si2 = 0; si2 < scr.length; si2++){
            var pp2 = scr[si2];
            if(!pp2){ started = false; continue; }
            if(!started){ ctx2d.moveTo(pp2[0], pp2[1]); started = true; } else ctx2d.lineTo(pp2[0], pp2[1]);
          }
          ctx2d.strokeStyle = 'rgba(' + colStr + ',' + (day ? passes[pi][1] * 1.4 : passes[pi][1]) + ')';
          ctx2d.lineWidth = passes[pi][0] * DPR;
          ctx2d.stroke();
        }
        var fi = Math.floor(flow * (scr.length - 1));
        var fp = scr[fi];
        if(fp){
          var spr2 = starSprite(rc, 'ray');
          var ssz = 10 * DPR;
          ctx2d.globalAlpha = day ? 0.20 : 0.34;
          ctx2d.drawImage(spr2, fp[0] - ssz, fp[1] - ssz, ssz * 2, ssz * 2);
          ctx2d.globalAlpha = 1;
        }
      }
      var core = projStar(0, 0, 0, view, proj, W, H);
      if(core){
        var cspr = starSprite(palette.memA, 'core');
        /* galaxy core 缩小：30→10，620→280。之前 840×840 软球 + bloom = 中央大白饼 */
        var csz = 10 * DPR * (280 / Math.max(80, core[2]));
        ctx2d.globalAlpha = day ? 0.40 : 0.70;
        ctx2d.drawImage(cspr, core[0] - csz, core[1] - csz, csz * 2, csz * 2);
        ctx2d.globalAlpha = 1;
      }
    }
    /* 特效粒子 */
    if(fx.pos){
      ctx2d.globalCompositeOperation = day ? 'source-over' : 'lighter';
      var fc = palette.fx;
      for(var f = 0; f < fx.max; f++){
        if(fx.life[f] <= 0) continue;
        var fp = projStar(fx.pos[f*3], fx.pos[f*3+1], fx.pos[f*3+2], view, proj, W, H);
        if(!fp) continue;
        var lf = Math.max(0, Math.min(1, fx.life[f]));
        var s2 = fx.size[f] * (300 / Math.max(40, fp[2])) * DPR * 2.2 * (0.6 + lf * 0.8);
        ctx2d.globalAlpha = lf * (day ? .18 : .30);
        var fsp = starSprite(fc, 'fx');
        var ssz2 = Math.max(1.2, Math.min(12, s2));
        ctx2d.drawImage(fsp, fp[0] - ssz2, fp[1] - ssz2, ssz2 * 2, ssz2 * 2);
      }
      ctx2d.globalAlpha = 1;
    }

    /* 记忆标签跟随：原来这段只写在 GL 分支里，而实际跑的是 2D 兜底路径，
       导致标签永远停在 opacity:0（CSS 默认值）——等于这个功能一直没生效 */
    if(labels.length && memStars && memStars.pos){
      var lw = canvas.clientWidth || 1, lh = canvas.clientHeight || 1;
      for(var li = 0; li < labels.length; li++){
        var L = labels[li], i3 = L.i * 3;
        if(i3 + 2 >= memStars.pos.length){ L.el.style.opacity = 0; continue; }
        var lx = memStars.pos[i3], ly = memStars.pos[i3+1], lz = memStars.pos[i3+2];
        var lb = memStars.bkt ? memStars.bkt[L.i] : 0;
        var lp = projStar(lx * _ca[lb] - lz * _sa[lb], ly, lx * _sa[lb] + lz * _ca[lb], view, proj, W, H);
        if(!lp){ L.el.style.opacity = 0; continue; }
        var lsx = lp[0] / DPR, lsy = lp[1] / DPR;   /* projStar 给的是画布像素，标签要 CSS 像素 */
        if(lsx < -80 || lsx > lw + 80 || lsy < -40 || lsy > lh + 40){ L.el.style.opacity = 0; continue; }
        L.el.style.left = lsx + 'px'; L.el.style.top = lsy + 'px';
        L.el.style.opacity = (modeT > 0.5 ? 0.92 : 0.9) * Math.max(0.25, Math.min(1, 1 - lp[2] / 620));
      }
    }

    /* 只晕高光，不抬暗部 */
    if(window.TE_STAR_QUALITY !== 'low' && !interacting) selectiveBloom(W, H, bloomList, day ? 0.14 : BLOOM_NIGHT);

    /* 撤掉上一版加的全场 bloomPass —— 和 selectiveBloom 叠加导致中心整片过曝（白饼），
       现在只保留 selectiveBloom 那一层，亮星溢光由它负责就够。 */

  }

  /* ---------- 交互 ---------- */
  var ptrs = {}, drag = null, moved = 0, downAt = 0, lastUserAt = 0;
  /* ================= 海上漂浮物：小船 · 漂流瓶 · 流星 ================= */
  var boats = [], bottles = [], meteors = [], _lastT = 0;
  var boatSprites = {}, bottleSprites = {};
  function makeBoatSprite(col){
    var key = 'b' + Math.round(col[0]*255) + '_' + Math.round(col[1]*255) + '_' + Math.round(col[2]*255);
    if(boatSprites[key]) return boatSprites[key];
    /* 以前是"两条直溜溜的三角形帆 + 一条细月牙"，放大看就是纸飞机。
       现在：弧形帆（带肚量）、甲板线、船艏高光、桅顶灯、船底倒影 + 一层柔和外发光。
       2x：150x128 → 300x256，小船放大两倍绘制，drawImage 缩放比减半变锐。 */
    var W = 300, H = 256, c = document.createElement('canvas'); c.width = W; c.height = H;
    var x = c.getContext('2d');
    var rgb = Math.round(col[0]*255) + ',' + Math.round(col[1]*255) + ',' + Math.round(col[2]*255);
    x.translate(W / 2, H * 0.62);
    x.lineJoin = 'round'; x.lineCap = 'round';

    /* ① 外层柔光：船不再是"贴上去的剪影" */
    var glow = x.createRadialGradient(0, -14, 4, 0, -10, 62);
    glow.addColorStop(0, 'rgba(' + rgb + ',0.30)');
    glow.addColorStop(0.5, 'rgba(' + rgb + ',0.10)');
    glow.addColorStop(1, 'rgba(' + rgb + ',0)');
    x.fillStyle = glow; x.beginPath(); x.arc(0, -10, 62, 0, 6.2832); x.fill();

    /* ② 船底倒影：先画，被船身压住上半截，水面才有"倒过来一条" */
    x.save();
    x.globalAlpha = 0.20;
    x.translate(0, 6); x.scale(1, -0.55);
    var gr = x.createLinearGradient(0, -26, 0, 16);
    gr.addColorStop(0, 'rgba(255,255,255,0.75)');
    gr.addColorStop(1, 'rgba(' + rgb + ',0.25)');
    x.fillStyle = gr;
    x.beginPath(); x.moveTo(-30, 0); x.quadraticCurveTo(0, 26, 30, 0);
    x.quadraticCurveTo(0, 12, -30, 0); x.closePath(); x.fill();
    x.beginPath(); x.moveTo(-2, -1); x.lineTo(-2, -44); x.lineTo(-24, -1); x.closePath(); x.fill();
    x.restore();

    /* ③ 船身：细长月牙 + 甲板线 + 船艏高光 */
    var gh = x.createLinearGradient(0, -3, 0, 15);
    gh.addColorStop(0, 'rgba(255,255,255,0.62)');
    gh.addColorStop(0.45, 'rgba(' + rgb + ',0.22)');
    gh.addColorStop(1, 'rgba(18,28,42,0.55)');
    x.fillStyle = gh;
    x.beginPath();
    x.moveTo(-33, 0); x.quadraticCurveTo(0, 21, 33, 0);
    x.quadraticCurveTo(0, 9, -33, 0); x.closePath(); x.fill();
    /* 甲板线（一条细一点的亮线，船就有了厚度） */
    x.strokeStyle = 'rgba(255,255,255,0.92)'; x.lineWidth = 1.5;
    x.beginPath(); x.moveTo(-33, 0); x.quadraticCurveTo(0, 20, 33, 0); x.stroke();
    x.strokeStyle = 'rgba(255,255,255,0.34)'; x.lineWidth = 1;
    x.beginPath(); x.moveTo(-30, 1.6); x.quadraticCurveTo(0, 15.5, 30, 1.6); x.stroke();
    /* 船艏高光点 */
    x.fillStyle = 'rgba(255,255,255,0.85)';
    x.beginPath(); x.arc(31.5, -0.6, 1.5, 0, 6.2832); x.fill();

    /* ④ 主帆：弧形（左边吃风鼓起），带一道缝线 */
    var g1 = x.createLinearGradient(-24, -52, 2, 2);
    g1.addColorStop(0, 'rgba(255,255,255,0.97)');
    g1.addColorStop(0.55, 'rgba(244,248,255,0.90)');
    g1.addColorStop(1, 'rgba(' + rgb + ',0.42)');
    x.fillStyle = g1;
    x.beginPath();
    x.moveTo(-2.5, -2);
    x.quadraticCurveTo(-16, -26, -27, -2);      /* 帆脚：鼓起来 */
    x.quadraticCurveTo(-14, -30, -2.5, -52);    /* 前缘 */
    x.closePath(); x.fill();
    x.strokeStyle = 'rgba(255,255,255,0.55)'; x.lineWidth = 0.9;
    x.beginPath(); x.moveTo(-3, -4); x.quadraticCurveTo(-12, -26, -25, -3); x.stroke();
    x.strokeStyle = 'rgba(' + rgb + ',0.35)'; x.lineWidth = 0.8;
    x.beginPath(); x.moveTo(-6, -7); x.quadraticCurveTo(-14, -26, -22, -8); x.stroke();

    /* ⑤ 前帆：小一号，另一侧，同样带弧 */
    var g2 = x.createLinearGradient(24, -38, 2, 0);
    g2.addColorStop(0, 'rgba(' + rgb + ',0.30)');
    g2.addColorStop(0.45, 'rgba(248,251,255,0.88)');
    g2.addColorStop(1, 'rgba(255,255,255,0.95)');
    x.fillStyle = g2;
    x.beginPath();
    x.moveTo(2.5, -1);
    x.quadraticCurveTo(18, -20, 25, -1);
    x.quadraticCurveTo(12, -22, 2.5, -38);
    x.closePath(); x.fill();
    x.strokeStyle = 'rgba(255,255,255,0.5)'; x.lineWidth = 0.8;
    x.beginPath(); x.moveTo(3, -3); x.quadraticCurveTo(15, -20, 23, -3); x.stroke();

    /* ⑥ 桅杆 + 桅顶灯 */
    x.strokeStyle = 'rgba(255,255,255,0.9)'; x.lineWidth = 1.3;
    x.beginPath(); x.moveTo(0, 0.5); x.lineTo(0, -54); x.stroke();
    var mg = x.createRadialGradient(0, -54, 0, 0, -54, 7);
    mg.addColorStop(0, 'rgba(255,246,214,0.95)');
    mg.addColorStop(0.4, 'rgba(255,232,168,0.42)');
    mg.addColorStop(1, 'rgba(255,220,140,0)');
    x.fillStyle = mg; x.beginPath(); x.arc(0, -54, 7, 0, 6.2832); x.fill();
    x.fillStyle = 'rgba(255,252,236,0.98)';
    x.beginPath(); x.arc(0, -54, 1.3, 0, 6.2832); x.fill();

    boatSprites[key] = c;
    return c;
  }
  function makeBottleSprite(col){
    var key = 'o' + Math.round(col[0]*255) + '_' + Math.round(col[1]*255) + '_' + Math.round(col[2]*255);
    if(bottleSprites[key]) return bottleSprites[key];
    var W = 64, H = 110, c = document.createElement('canvas'); c.width = W; c.height = H;
    var x = c.getContext('2d');
    var rgb = Math.round(col[0]*255) + ',' + Math.round(col[1]*255) + ',' + Math.round(col[2]*255);
    x.translate(W/2, H/2 + 6);
    /* 瓶身：玻璃高光 + 柔和轮廓（不要硬塑料描边） */
    x.shadowColor = 'rgba(' + rgb + ',0.85)';
    x.shadowBlur = 14;
    var gb = x.createLinearGradient(-13, 0, 13, 0);
    gb.addColorStop(0, 'rgba(' + rgb + ',0.16)');
    gb.addColorStop(0.32, 'rgba(255,255,255,0.34)');
    gb.addColorStop(0.62, 'rgba(' + rgb + ',0.20)');
    gb.addColorStop(1, 'rgba(' + rgb + ',0.10)');
    x.beginPath();
    x.moveTo(-11, -14); x.lineTo(-11, 30);
    x.quadraticCurveTo(-11, 40, 0, 40); x.quadraticCurveTo(11, 40, 11, 30);
    x.lineTo(11, -14);
    x.quadraticCurveTo(11, -22, 5, -24); x.lineTo(5, -36); x.lineTo(-5, -36); x.lineTo(-5, -24);
    x.quadraticCurveTo(-11, -22, -11, -14); x.closePath();
    x.fillStyle = gb; x.fill();
    x.shadowBlur = 0;
    x.strokeStyle = 'rgba(255,255,255,0.55)'; x.lineWidth = 1.2; x.stroke();
    /* 里面的纸质纸条（暖白 + 微微卷起），不是塑料感 */
    x.save(); x.rotate(-0.42);
    var gp = x.createLinearGradient(-4, 0, 4, 0);
    gp.addColorStop(0, 'rgba(255,250,238,0.98)');
    gp.addColorStop(0.55, 'rgba(246,232,204,0.95)');
    gp.addColorStop(1, 'rgba(226,205,170,0.9)');
    x.fillStyle = gp;
    x.fillRect(-4, -4, 8, 22);
    x.fillStyle = 'rgba(190,160,120,0.5)';
    x.fillRect(-4, -4, 8, 2.2);
    x.fillRect(-4, 8, 8, 1.4);
    x.restore();
    /* 软木塞 */
    x.fillStyle = 'rgba(214,178,132,0.95)';
    x.beginPath(); x.moveTo(-6, -44); x.lineTo(6, -44); x.lineTo(5, -36); x.lineTo(-5, -36); x.closePath(); x.fill();
    bottleSprites[key] = c;
    return c;
  }
  function spawnMeteor(initial){
    var a = Math.random() * Math.PI * 2;
    var r0 = 16 + Math.random() * 16;
    var dir = [-Math.sin(a) * rnd(0.6, 1.0) + rnd(-0.25, 0.25), rnd(-0.5, 0.2), Math.cos(a) * rnd(0.6, 1.0) + rnd(-0.25, 0.25)];
    var L = Math.hypot(dir[0], dir[1], dir[2]) || 1;
    meteors.push({
      p: [Math.cos(a) * r0, rnd(-34, 20), Math.sin(a) * r0],
      d: [dir[0]/L, dir[1]/L, dir[2]/L],
      speed: rnd(16, 34), len: rnd(22, 46), w: rnd(1.2, 2.4),
      life: initial ? Math.random() : 1, ttl: rnd(1.6, 3.0)
    });
  }
  /* 漂浮物用色：浅色 + 饱和（跟随主题色相），主题一换就跟着换 */
  function floatColor(soft){
    var hb = themeHue();
    var l = soft ? 0.90 : 0.85;
    var sat = desat(soft ? 0.48 : 0.58);
    var hh = hb + (soft ? 6 : 2);
    return [hslOne(hh, sat, l, 0), hslOne(hh, sat, l, 1), hslOne(hh, sat, l, 2)];
  }
  /* 给每只船/瓶子配一圈"贴身星"，跟它们一起动，永远贴着 */
  function makeNest(n, spread){
    var arr = [];
    for(var i = 0; i < n; i++){
      var a = Math.random() * 6.283;
      var rr = Math.pow(Math.random(), 0.6) * spread;
      arr.push({ x: Math.cos(a) * rr, y: Math.sin(a) * rr * 0.82, s: rnd(0.7, 1.9), ph: Math.random() * 6.283 });
    }
    return arr;
  }
  function drawNest(nest, sx, sy, R, t, col, day){
    var spr = starSprite(col);
    var n = nest.length;
    for(var i = 0; i < n; i++){
      var st = nest[i];
      var tw = 0.55 + 0.45 * Math.sin(t * 2.1 + st.ph);
      var px = sx + st.x * R, py = sy + st.y * R;
      var sz = st.s * 1.95;
      ctx2d.globalAlpha = Math.max(0.2, Math.min(1, tw * (day ? 0.75 : 1)));
      if(sz <= 2.2){
        ctx2d.fillStyle = 'rgb(' + Math.round(col[0]*255) + ',' + Math.round(col[1]*255) + ',' + Math.round(col[2]*255) + ')';
        ctx2d.fillRect(px - sz/2, py - sz/2, sz, sz);
      } else {
        ctx2d.drawImage(spr, px - sz*1.6, py - sz*1.6, sz*3.2, sz*3.2);
      }
    }
    ctx2d.globalAlpha = 1;
  }

  function initFloat(){
    if(boats.length) return;
    boats = [];
    var boatSpots = [
      [4.5,  -52, 1.55], [11, -44, 0.72], [17, -30, 1.15], [8,  -20, 0.55],
      [21, -10, 1.35], [13,  1,  0.80], [24, -40, 0.62], [6,  -2, 1.05]
    ];
    for(var bi = 0; bi < boatSpots.length; bi++){
      boats.push({
        r: boatSpots[bi][0], y: boatSpots[bi][1], sc: boatSpots[bi][2],
        ang: bi * 1.27 + 0.4, ph: bi * 2.1, sp: 0.02 + (bi % 3) * 0.014,
        wob: 0, _sx: -999, _sy: -999
      });
    }
    rebuildBottles();
    meteors = [];
    for(var j = 0; j < 4; j++) spawnMeteor(true);
  }
  function drawFloat2D(t, dt, view, proj, W, H, day){
    initFloat();
    var col = day ? [.17,.33,.43] : [.30,.41,.53];
    if(quietMotion && quietMotion.matches) dt*=0.55;   /* 同样减速而不是冻住 */
    ctx2d.globalCompositeOperation = 'source-over';
    ctx2d.lineCap = 'round';
    for(var i = meteors.length - 1; !day && !(quietMotion && quietMotion.matches) && i >= 0; i--){
      var m = meteors[i];
      m.life -= dt / m.ttl;
      if(m.life <= 0){ meteors.splice(i, 1); spawnMeteor(false); continue; }
      var sp = m.speed * dt;
      m.p[0] += m.d[0] * sp; m.p[1] += m.d[1] * sp; m.p[2] += m.d[2] * sp;
      var h1 = projStar(m.p[0], m.p[1], m.p[2], view, proj, W, H);
      var h2 = projStar(m.p[0] - m.d[0] * m.len, m.p[1] - m.d[1] * m.len, m.p[2] - m.d[2] * m.len, view, proj, W, H);
      if(!h1 || !h2) continue;
      var alpha = Math.max(0, Math.min(1, m.life * 1.4)) * 0.16;
      var rc = Math.round(col[0]*255) + ',' + Math.round(col[1]*255) + ',' + Math.round(col[2]*255);
      var g = ctx2d.createLinearGradient(h1[0], h1[1], h2[0], h2[1]);
      g.addColorStop(0, 'rgba(255,255,255,' + (alpha * 0.95).toFixed(3) + ')');
      g.addColorStop(0.25, 'rgba(' + rc + ',' + (alpha * 0.5).toFixed(3) + ')');
      g.addColorStop(1, 'rgba(' + rc + ',0)');
      ctx2d.strokeStyle = g;
      ctx2d.lineWidth = m.w * DPR;
      ctx2d.beginPath(); ctx2d.moveTo(h1[0], h1[1]); ctx2d.lineTo(h2[0], h2[1]); ctx2d.stroke();
      var hs = starSprite([1, 1, 1], 'white'), hsz = 10 * DPR;
      ctx2d.globalAlpha = alpha;
      ctx2d.drawImage(hs, h1[0] - hsz, h1[1] - hsz, hsz * 2, hsz * 2);
      ctx2d.globalAlpha = 1;
    }
    for(var bi2 = 0; bi2 < boats.length; bi2++){
      var bt = boats[bi2];
      bt.ang += dt * bt.sp;
      if(bt.wob > 0) bt.wob = Math.max(0, bt.wob - dt * 1.4);
      var bpos = [Math.cos(bt.ang) * bt.r, bt.y + Math.sin(t * 0.7 + bt.ph) * 3.2, Math.sin(bt.ang) * bt.r];
      var bn2 = Math.max(1, boats.length - 1), _fr = bi2 / bn2;
      var bp;
      bp = projStar(bpos[0], bpos[1], bpos[2], view, proj, W, H);
      if(!bp) { bt._sx = bt._sy = -9999; continue; }
      bt._wx = bpos[0]; bt._wy = bpos[1]; bt._wz = bpos[2];
      var bscale = Math.max(0.28, Math.min(1.5, 118 / Math.max(60, bp[2]))) * bt.sc * 0.72;
      if(!bt.nest) bt.nest = makeNest(80, 3.6);
      if(!bt.nestCol) bt.nestCol = floatColor(true);
      ctx2d.globalCompositeOperation = 'source-over';
      // Decorative luminous nests removed.
      var bs = makeBoatSprite(col);
      var bw = 96 * bscale * DPR, bh = 72 * bscale * DPR;
      if(!day){
        ctx2d.globalCompositeOperation = 'lighter';
        var rsp = starSprite(col, 'boatglow');
        ctx2d.globalAlpha = 0.12;
        ctx2d.drawImage(rsp, bp[0] - bw * 0.9, bp[1] + bh * 0.05, bw * 1.8, bh * 0.55);
      }
      ctx2d.globalCompositeOperation = 'source-over';
      ctx2d.globalAlpha = day ? .95 : .86;
      ctx2d.save();
      ctx2d.translate(bp[0], bp[1]);
      ctx2d.rotate(Math.sin(t * 0.8 + bt.ph) * 0.07 + Math.sin(t * 26) * 0.16 * bt.wob);
      var sc2 = 1 + 0.14 * bt.wob;
      ctx2d.drawImage(bs, -bw*sc2/2, -bh*sc2/2, bw*sc2, bh*sc2);
      ctx2d.restore();
      bt._sx = bp[0] / DPR; bt._sy = bp[1] / DPR;   /* 存成 CSS 像素，和点击坐标同一坐标系 */
    }
    var bcol = day ? [.20,.41,.37] : [.31,.48,.43];
    for(var k = 0; k < bottles.length; k++){
      var bo = bottles[k];
      bo.ang += dt * bo.sp;
      if(bo.pop > 0) bo.pop -= dt * 1.6;
      var _bn = Math.max(1, bottles.length - 1), _bfr = k / _bn;
      var pp;
      pp = projStar(Math.cos(bo.ang) * bo.r, bo.y + Math.sin(t * 0.9 + bo.ph) * 3.4, Math.sin(bo.ang) * bo.r, view, proj, W, H);
      if(!pp) { bo._sx = bo._sy = -9999; continue; }
      var sc = Math.max(0.4, Math.min(1.7, 88 / Math.max(60, pp[2])));
      if(!bo.nest) bo.nest = makeNest(46, 3.4);
      if(!bo.nestCol) bo.nestCol = floatColor(true);
      ctx2d.globalCompositeOperation = 'source-over';
      // Keep the bottle silhouette without a noisy particle halo.
      var spr = makeBottleSprite(bcol);
      var ow = 40 * sc * DPR, oh = 72 * sc * DPR;
      ctx2d.globalCompositeOperation = 'source-over';
      ctx2d.globalAlpha = day ? .95 : .84;
      ctx2d.save();
      ctx2d.translate(pp[0], pp[1]);
      ctx2d.rotate(Math.sin(t * 0.6 + bo.ph) * 0.22);
      ctx2d.drawImage(spr, -ow/2, -oh/2, ow, oh);
      ctx2d.restore();
      if(bo.pop > 0){
        var gsp = starSprite([1, 1, 1], 'white');
        var gsz = 46 * DPR * (1 - bo.pop) * 2;
        ctx2d.globalAlpha = Math.min(1, bo.pop) * 0.8;
        ctx2d.drawImage(gsp, pp[0] - gsz, pp[1] - gsz, gsz * 2, gsz * 2);
      }
      bo._sx = pp[0] / DPR; bo._sy = pp[1] / DPR;
      ctx2d.globalAlpha = 1;
    }
  }


  /* ================= 星球 & 点缀（星海更丰富） ================= */
  var planets = [], PLANET_SPR = {};
  /* 星球精灵的画布留白系数：画布边长 = 半径 × K。
     以前 K=2.4，比外发光的半径(2.1R)还小 —— 发光被画布边缘切掉，
     屏幕上就是每个星球周围一个方框。现在留够余量，绘制时按同一个 K 缩回去，
     星球本身的大小和以前一模一样。 */
  var PLANET_SPR_K = 4.6;
  function initPlanets(){
    if(planets.length) return;
    planets = [
      /* orb = 公转半径；以前只有 2~3 个单位、周期 5 分钟，看着像贴上去不动的贴纸。
         现在绕场景中心转，并且带出明显的纵深变化（近大远小），才有真实感。 */
      { x: -19, y:  27, z:  -6, r: 58, c1: '#8aa8e6', c2: '#26305c', ring: 1, ph: 0.0, sp: 0.052, orb: 26, drift: 3.2 },
      { x:  17, y: -31, z:   5, r: 44, c1: '#e2a3b3', c2: '#5d2536', ring: 0, ph: 1.7, sp: 0.041, orb: 20, drift: 2.6 },
      { x: -15, y: -39, z:  -3, r: 30, c1: '#a6dcc9', c2: '#1f4a3f', ring: 0, ph: 3.1, sp: 0.067, orb: 15, drift: 2.2 },
      { x:  21, y:  33, z:   9, r: 23, c1: '#efdda6', c2: '#63512a', ring: 1, ph: 4.6, sp: 0.033, orb: 11, drift: 1.8 },
      { x:  -4, y:  41, z: -14, r: 17, c1: '#c7a8ef', c2: '#3c2a5e', ring: 0, ph: 5.5, sp: 0.078, orb: 8,  drift: 2.9 }
    ];
  }
  function planetSprite(p){
    var key = p.c1 + '_' + p.c2 + '_' + (p.ring ? 1 : 0) + '_' + Math.round(p.r);
    if(PLANET_SPR[key]) return PLANET_SPR[key];
    var S = Math.round(p.r * PLANET_SPR_K), c = document.createElement('canvas');
    c.width = c.height = S;
    var x = c.getContext('2d'), cx = S / 2, cy = S / 2, R = p.r;
    var ROT = -0.42, SQ = 0.26;              /* 光环的倾角与压扁比 */

    /* 画一圈光环（多条细带 + 中间的间隙，比一条粗线像样得多） */
    function ringBands(alpha){
      var bands = [[1.30, 0.055, 0.50], [1.40, 0.085, 0.72], [1.50, 0.030, 0.30],
                   [1.62, 0.050, 0.42], [1.72, 0.022, 0.22]];
      for(var k = 0; k < bands.length; k++){
        var rr = R * bands[k][0];
        x.lineWidth = Math.max(1, R * bands[k][1] * 2);
        x.strokeStyle = hexA2(p.c1, bands[k][2] * alpha);
        x.beginPath(); x.arc(0, 0, rr, 0, 6.2832); x.stroke();
      }
      /* 环上最亮的一圈加一点白，边缘才不会"糊成一片灰" */
      x.lineWidth = Math.max(1, R * 0.03);
      x.strokeStyle = hexA2('#ffffff', 0.20 * alpha);
      x.beginPath(); x.arc(0, 0, R * 1.45, 0, 6.2832); x.stroke();
    }
    function ringHalf(front){
      x.save();
      x.translate(cx, cy); x.rotate(ROT); x.scale(1, SQ);
      x.beginPath();
      if(front) x.rect(-S, 0, S * 2, S); else x.rect(-S, -S, S * 2, S);
      x.clip();
      ringBands(1);
      x.restore();
    }

    /* ① 最外层柔光：两层，宽而淡，星球才不像剪贴上去的 */
    var g0 = x.createRadialGradient(cx, cy, R * 0.9, cx, cy, R * 2.1);
    g0.addColorStop(0, hexA2(p.c1, 0.16));
    g0.addColorStop(0.45, hexA2(p.c1, 0.055));
    g0.addColorStop(1, hexA2(p.c1, 0));
    x.fillStyle = g0; x.beginPath(); x.arc(cx, cy, R * 2.1, 0, 6.2832); x.fill();

    /* ② 光环 · 后半（在球体下面） */
    if(p.ring) ringHalf(false);

    /* ③ 球体：不用纯白高光，改成"带一点自己颜色的亮面" */
    x.save();
    x.beginPath(); x.arc(cx, cy, R, 0, 6.2832); x.clip();
    var g = x.createRadialGradient(cx - R * 0.36, cy - R * 0.40, R * 0.06, cx - R * 0.10, cy - R * 0.12, R * 1.25);
    g.addColorStop(0, hexA2('#ffffff', 0.88));
    g.addColorStop(0.14, hexA2(p.c1, 0.98));
    g.addColorStop(0.55, hexA2(p.c1, 0.72));
    g.addColorStop(0.86, hexA2(p.c2, 0.92));
    g.addColorStop(1, hexA2(p.c2, 1));
    x.fillStyle = g; x.fillRect(cx - R, cy - R, R * 2, R * 2);

    /* 云带：宽窄不一、带一点弧度，别是一排整齐的横条 */
    for(var b = -5; b <= 5; b++){
      var yy = cy + b * R * 0.19 + Math.sin(b * 1.7 + p.ph) * R * 0.05;
      var hh = R * (0.030 + 0.028 * Math.abs(Math.sin(b * 2.3 + p.ph)));
      x.globalAlpha = 0.10 + 0.07 * Math.abs(Math.cos(b * 1.1 + p.ph));
      x.fillStyle = (b % 2) ? p.c1 : p.c2;
      x.beginPath();
      x.ellipse(cx + Math.sin(b * 0.9) * R * 0.08, yy, R * 1.02, hh, Math.sin(b) * 0.05, 0, 6.2832);
      x.fill();
    }
    /* 亮面的一点云雾（斜着的，别是一坨圆） */
    x.globalAlpha = 0.16; x.fillStyle = '#ffffff';
    x.beginPath(); x.ellipse(cx - R * 0.26, cy - R * 0.44, R * 0.60, R * 0.20, -0.55, 0, 6.2832); x.fill();
    x.beginPath(); x.ellipse(cx + R * 0.22, cy - R * 0.20, R * 0.42, R * 0.12, -0.42, 0, 6.2832); x.fill();
    x.globalAlpha = 1;

    /* 边缘变暗（limb darkening）——球才有体积感 */
    var gl = x.createRadialGradient(cx, cy, R * 0.62, cx, cy, R);
    gl.addColorStop(0, 'rgba(0,0,0,0)');
    gl.addColorStop(0.82, hexA2(p.c2, 0.30));
    gl.addColorStop(1, hexA2(p.c2, 0.72));
    x.fillStyle = gl; x.fillRect(cx - R, cy - R, R * 2, R * 2);
    /* 背光侧压暗一点，方向跟高光相反 */
    var gs = x.createRadialGradient(cx + R * 0.45, cy + R * 0.50, R * 0.10, cx + R * 0.30, cy + R * 0.34, R * 1.15);
    gs.addColorStop(0, hexA2(p.c2, 0.42));
    gs.addColorStop(1, 'rgba(0,0,0,0)');
    x.fillStyle = gs; x.fillRect(cx - R, cy - R, R * 2, R * 2);
    x.restore();

    /* ④ 大气边缘：只在球体外面薄薄一圈 */
    x.save();
    var ga = x.createRadialGradient(cx, cy, R * 0.93, cx, cy, R * 1.045);
    ga.addColorStop(0, 'rgba(0,0,0,0)');
    ga.addColorStop(0.55, hexA2(p.c1, 0.30));
    ga.addColorStop(1, 'rgba(0,0,0,0)');
    x.fillStyle = ga; x.beginPath(); x.arc(cx, cy, R * 1.05, 0, 6.2832); x.fill();
    x.restore();

    /* ⑤ 光环 · 前半（压在球体下缘） */
    if(p.ring) ringHalf(true);

    PLANET_SPR[key] = c;
    return c;
  }
  function hexA2(hex, a){
    hex = String(hex).trim();
    if(hex.charAt(0) !== '#') return hex;
    if(hex.length === 4) hex = '#' + hex[1]+hex[1]+hex[2]+hex[2]+hex[3]+hex[3];
    return 'rgba(' + parseInt(hex.substr(1,2),16) + ',' + parseInt(hex.substr(3,2),16) + ',' + parseInt(hex.substr(5,2),16) + ',' + a + ')';
  }
  var sparkSprites = {};
  /* 真实感星芒：亮核 + 柔晕 + 四条渐变光芒 */
  function sparkSprite(scale){
    var key = 'sp' + scale;
    if(sparkSprites[key]) return sparkSprites[key];
    /* 2x：96*scale → 192*scale。星芒精灵变大，缩放比减半 */
    var S = Math.round(192 * scale), c = document.createElement('canvas');
    c.width = c.height = S;
    var x = c.getContext('2d'), h = S / 2;
    var g = x.createRadialGradient(h, h, 0, h, h, h * 0.5);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.18, 'rgba(255,255,255,.62)');
    g.addColorStop(0.5, 'rgba(210,228,255,.18)');
    g.addColorStop(1, 'rgba(190,215,255,0)');
    x.fillStyle = g; x.fillRect(0, 0, S, S);
    /* 四条光芒：用线性渐变画细长三角 */
    function spike(len, wide, rot, alpha){
      x.save(); x.translate(h, h); x.rotate(rot);
      var lg = x.createLinearGradient(0, 0, len, 0);
      lg.addColorStop(0, 'rgba(255,255,255,' + alpha + ')');
      lg.addColorStop(0.35, 'rgba(255,255,255,' + (alpha * 0.35) + ')');
      lg.addColorStop(1, 'rgba(255,255,255,0)');
      x.fillStyle = lg;
      x.beginPath(); x.moveTo(0, -wide); x.lineTo(len, 0); x.lineTo(0, wide); x.closePath(); x.fill();
      x.restore();
    }
    spike(h * 0.96, S * 0.026, 0, 0.85);
    spike(h * 0.96, S * 0.026, Math.PI, 0.85);
    spike(h * 0.62, S * 0.018, Math.PI / 2, 0.5);
    spike(h * 0.62, S * 0.018, -Math.PI / 2, 0.5);
    x.save(); x.translate(h, h); x.rotate(Math.PI / 4);
    spike(h * 0.34, S * 0.010, 0, 0.28);
    spike(h * 0.34, S * 0.010, Math.PI, 0.28);
    x.restore();
    sparkSprites[key] = c;
    return c;
  }
  var sparkles = [];
  function initSparkles(){
    if(sparkles.length) return;
    for(var i = 0; i < 14; i++){
      sparkles.push({ x: rnd(-26, 26), y: rnd(-48, 48), z: rnd(-20, 20), s: rnd(1.8, 4.2), ph: Math.random() * 6.283 });
    }
  }
  function drawPlanets2D(t, view, proj, W, H, day){
    initPlanets(); initSparkles();
    /* 十字星芒（点缀） */
    ctx2d.globalCompositeOperation = day ? 'source-over' : 'lighter';
    ctx2d.lineCap = 'round';
    for(var i = 0; i < sparkles.length; i++){
      var sp = sparkles[i];
      var q = projStar(sp.x + Math.sin(t * 0.2 + sp.ph) * 1.6, sp.y + Math.cos(t * 0.17 + sp.ph) * 1.6, sp.z, view, proj, W, H);
      if(!q) continue;
      var tw = 0.45 + 0.55 * Math.abs(Math.sin(t * 1.1 + sp.ph));
      var L = sp.s * (620 / Math.max(80, q[2])) * DPR;
      if(L < 4) continue;
      var spr2 = sparkSprite(1);
      ctx2d.globalAlpha = tw * (day ? 0.5 : 0.95);
      ctx2d.drawImage(spr2, q[0] - L, q[1] - L, L * 2, L * 2);
    }
    /* 星球 */
    ctx2d.globalCompositeOperation = day ? 'source-over' : 'lighter';
    for(var j = 0; j < planets.length; j++){
      var p = planets[j];
      var ang = t * p.sp + p.ph;
      var orb = p.orb || p.drift || 2;
      /* 绕场景中心公转（x-z 平面）+ 上下起伏，z 变化会带来近大远小的透视 */
      var px = p.x + Math.cos(ang) * orb;
      var pz = p.z + Math.sin(ang) * orb;
      var py = p.y + Math.sin(ang * 1.7 + p.ph) * orb * 0.45;
      var pp = projStar(px, py, pz, view, proj, W, H);
      if(!pp) continue;
      var scale = (620 / Math.max(80, pp[2])) * DPR * (day ? 0.95 : 1);
      var spr = planetSprite(p);
      /* 按同一个留白系数缩回去，星球在屏幕上的大小与旧版一致 */
      var dw = spr.width * scale * 0.085 * (2.4 / PLANET_SPR_K), dh = dw;
      ctx2d.globalAlpha = day ? 0.35 : 0.6;
      ctx2d.drawImage(spr, pp[0] - dw / 2, pp[1] - dh / 2, dw, dh);
    }
    ctx2d.globalAlpha = 1;
  }

  /* 相机的右/上向量：与 lookAt 完全一致（之前这里左右搞反了，所以效果会出现在镜像的另一边） */
  function camBasis(){
    var eye = camEye();
    var fwd = [target[0] - eye[0], target[1] - eye[1], target[2] - eye[2]];
    var fl = Math.hypot(fwd[0], fwd[1], fwd[2]) || 1;
    fwd = [fwd[0]/fl, fwd[1]/fl, fwd[2]/fl];
    var z = [-fwd[0], -fwd[1], -fwd[2]];                 /* 相机朝后 */
    var up0 = [0, 1, 0];
    var rx = up0[1]*z[2] - up0[2]*z[1], ry = up0[2]*z[0] - up0[0]*z[2], rz = up0[0]*z[1] - up0[1]*z[0];
    var rl = Math.hypot(rx, ry, rz) || 1; rx /= rl; ry /= rl; rz /= rl;
    var ux = z[1]*rz - z[2]*ry, uy = z[2]*rx - z[0]*rz, uz = z[0]*ry - z[1]*rx;
    return { right: [rx, ry, rz], up: [ux, uy, uz], dist: fl, eye: eye, fwd: fwd };
  }
  function worldFromScreen(sx, sy){
    /* 把屏幕点投到"过 target、垂直于视线"的平面上 */
    var w = canvas.clientWidth, h = canvas.clientHeight;
    var aspect = w / Math.max(1, h), fovy = 52 * Math.PI / 180;
    var ndcX = (sx / w) * 2 - 1, ndcY = 1 - (sy / h) * 2;
    var tanF = Math.tan(fovy / 2);
    var b = camBasis(), depth = b.dist;
    var kx = ndcX * tanF * aspect * depth, ky = ndcY * tanF * depth;
    return [
      target[0] + b.right[0] * kx + b.up[0] * ky,
      target[1] + b.right[1] * kx + b.up[1] * ky,
      target[2] + b.right[2] * kx + b.up[2] * ky
    ];
  }
  function camEye(){
    var cp = Math.cos(pitch), sp = Math.sin(pitch);
    return [target[0] + dist * cp * Math.sin(yaw), target[1] + dist * sp, target[2] + dist * cp * Math.cos(yaw)];
  }
  function bindInput(){
    canvas.addEventListener('pointerdown', function(e){
      ptrs[e.pointerId] = { x: e.clientX, y: e.clientY };
      try{ canvas.setPointerCapture(e.pointerId); }catch(x){}
      lastUserAt = performance.now();
      if(Object.keys(ptrs).length === 1){ drag = { x: e.clientX, y: e.clientY, t: performance.now() }; moved = 0; downAt = performance.now(); }
    });
    canvas.addEventListener('pointermove', function(e){
      if(!ptrs[e.pointerId]) return;
      lastUserAt = performance.now();
      var prev = ptrs[e.pointerId];
      var ids = Object.keys(ptrs);
      if(ids.length === 1 && drag){
        var dx = e.clientX - prev.x, dy = e.clientY - prev.y;
        moved += Math.hypot(dx, dy);
        yaw -= dx * 0.0052; pitch = Math.max(-1.25, Math.min(1.25, pitch + dy * 0.0042));
        vYaw = -dx * 0.0022; vPitch = dy * 0.0016;
        var wp = worldFromScreen(e.clientX, e.clientY);
        if(moved > 6) trail(wp);
      } else if(ids.length >= 2){
        /* 双指：中点拖动 = 平移；间距变化 = 缩放 */
        var id0 = ids[0], id1 = ids[1];
        var a = ptrs[id0], b = ptrs[id1];
        var cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
        var dPrev = Math.hypot(a.x - b.x, a.y - b.y);
        ptrs[e.pointerId] = { x: e.clientX, y: e.clientY };
        a = ptrs[id0]; b = ptrs[id1];
        var cx2 = (a.x + b.x) / 2, cy2 = (a.y + b.y) / 2;
        var dNow = Math.hypot(a.x - b.x, a.y - b.y);
        var panScale = dist * 0.0016;
        var eye = camEye(), fwd = [target[0]-eye[0], target[1]-eye[1], target[2]-eye[2]];
        var fl = Math.hypot(fwd[0],fwd[1],fwd[2]) || 1; fwd = [fwd[0]/fl, fwd[1]/fl, fwd[2]/fl];
        var right = [fwd[2], 0, -fwd[0]]; var rl = Math.hypot(right[0], right[2]) || 1; right = [right[0]/rl, 0, right[2]/rl];
        var up = [0, 1, 0];
        var mdx = (cx2 - cx) * panScale, mdy = (cy2 - cy) * panScale;
        target[0] -= right[0] * mdx + up[0] * mdy; target[1] -= right[1] * mdx + up[1] * mdy; target[2] -= right[2] * mdx + up[2] * mdy;
        if(dPrev > 8 && dNow > 8){ dist = Math.max(24, Math.min(700, dist * (dPrev / dNow))); }
      }
      ptrs[e.pointerId] = { x: e.clientX, y: e.clientY };
    });
    function up(e){
      if(!ptrs[e.pointerId]) return;
      delete ptrs[e.pointerId];
      var dur = performance.now() - downAt;
      if(drag && moved < 10 && dur < 420){
        var wp = worldFromScreen(e.clientX, e.clientY);
        ripple(wp, false);
        tapMemory(e.clientX, e.clientY);
      }
      if(Object.keys(ptrs).length === 0) drag = null;
    }
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);
    canvas.addEventListener('wheel', function(e){
      e.preventDefault();
      dist = Math.max(24, Math.min(700, dist * (1 + Math.sign(e.deltaY) * 0.08)));
    }, { passive: false });
  }

  /* 点中记忆星 → 弹出这条记忆 */
  function tapMemory(sx, sy){
    try{
      /* 先看有没有点到漂流瓶 / 小船 */
      if(bottles.length){
        for(var bi = 0; bi < bottles.length; bi++){
          var bb = bottles[bi];
          if(Math.hypot((bb._sx || -999) - sx, (bb._sy || -999) - sy) < 38){
            bb.pop = 1;
            var wp = [Math.cos(bb.ang) * bb.r, bb.y, Math.sin(bb.ang) * bb.r];
            flyTo(wp, 30);
            ripple(wp, false);
            try{ if(window.teSnd) window.teSnd.chime(); }catch(e){}
    setTimeout(function(){ showLetter(bb); }, 720);
            return true;
          }
        }
      }
      var hitBoat = null;
      for(var bk = 0; bk < boats.length; bk++){
        if(Math.hypot((boats[bk]._sx || -999) - sx, (boats[bk]._sy || -999) - sy) < 46){ hitBoat = boats[bk]; break; }
      }
      if(hitBoat){
        /* 触碰特效：这只船晃一下 + 一圈水花（不弹提示） */
        hitBoat.wob = 1;
        var bw2 = [hitBoat._wx, hitBoat._wy, hitBoat._wz];
        ripple(bw2, true);
        for(var qi = 0; qi < 26; qi++){
          var qa = Math.random() * 6.283, qs = rnd(3, 11);
          spawn([bw2[0] + Math.cos(qa) * 2.5, bw2[1] + 1.5, bw2[2] + Math.sin(qa) * 2.5],
                [Math.cos(qa) * qs, rnd(2, 9), Math.sin(qa) * qs], [1, rnd(0.7, 1)], rnd(0.5, 1.2), rnd(0.35, 0.7));
        }
        return true;
      }
      if(!memStars || !memStars.pos || !memories.length) return;
      var vw = canvas.clientWidth, vh = canvas.clientHeight;
      var aspect = vw / Math.max(1, vh);
      var proj = perspective(52 * Math.PI / 180, aspect, 1, 2200);
      var view = lookAt(camEye(), target, [0, 1, 0]);
      var best = -1, bestD = 40;
      /* 命中判定必须跟渲染用同一套自转，否则星海一转，点记忆星就点不准了 */
      var tNow = _lastT || 0;   /* 与渲染同一时间轴（渲染已在内部减速） */
      for(var i = 0; i < memStars.count; i++){
        var mb = memStars.bkt ? memStars.bkt[i] : 0;
        var ma = use2D ? spinAngleAt(tNow, mb) : 0, ms = use2D ? spinScaleAt(tNow, mb) : 1;
        var mca = Math.cos(ma) * ms, msa = Math.sin(ma) * ms;
        var mx0 = memStars.pos[i*3], mz0 = memStars.pos[i*3+2];
        var p = projStar(mx0 * mca - mz0 * msa, memStars.pos[i*3+1], mx0 * msa + mz0 * mca, view, proj, vw, vh);
        if(!p) continue;
        var d = Math.hypot(p[0] - sx, p[1] - sy);
        if(d < bestD){ bestD = d; best = i; }
      }
      var pop = document.getElementById('teStarPop');
      if(best < 0){ if(pop) pop.style.display = 'none'; return false; }
      if(!pop){
        pop = document.createElement('div');
        pop.id = 'teStarPop';
        pop.className = 'st-pop';
        document.getElementById('p-star').appendChild(pop);
      }
      var m = memories[best];
      var dt = m.at ? new Date(m.at) : null;
      pop.innerHTML = '<b>' + esc(m.text.slice(0, 90)) + '</b><i>' + esc(m.bank) + (dt ? ' · ' + dt.getFullYear() + '.' + (dt.getMonth()+1) + '.' + dt.getDate() : '') + '</i>';
      pop.style.display = 'block';
      clearTimeout(pop.__t);
      pop.__t = setTimeout(function(){ pop.style.display = 'none'; }, 4200);
      return true;
    }catch(e){ return false; }
  }


  /* ================= 许愿 & 漂流瓶 ================= */
  function wishesLoad(){ try{ return JSON.parse(localStorage.getItem('te_wishes') || '[]'); }catch(e){ return []; } }
  function wishesSave(list){ try{ localStorage.setItem('te_wishes', JSON.stringify(list)); }catch(e){} }
  function rebuildBottles(){
    var ws = wishesLoad();
    bottles = [];
    var show = Math.min(ws.length, 26);
    for(var i = 0; i < show; i++){
      var a = i * 2.399963 + 0.7;
      bottles.push({
        wish: ws[i], widx: i,
        ang: a, r: 6 + (i % 5) * 3.4, y: -46 + (i % 6) * 7.5,
        ph: i * 1.7, sp: 0.018 + (i % 3) * 0.012, pop: 0, _sx: -999, _sy: -999
      });
    }
    for(var k = 0; k < 3; k++){
      bottles.push({ wish: null, ang: Math.random() * 6.283, r: 8 + Math.random() * 12,
                     y: rnd(-46, -22), ph: Math.random() * 6.283, sp: 0.02 + Math.random() * 0.04,
                     pop: 0, _sx: -999, _sy: -999 });
    }
    var sub = document.getElementById('teStarSub');
    if(sub) sub.textContent = ws.length ? (ws.length + ' 只漂流瓶 · ' + (window.__starMemCount || 0) + ' 条记忆') : 'NAMELESS COASTLINE · v109';
  }
  window.teStarWishesRebuild = rebuildBottles;
  window.__starBottleXY = function(){ return bottles.map(function(b){ return [Math.round(b._sx), Math.round(b._sy)]; }); };
  window.__starOpenBottle = function(i){ var b = bottles[i]; if(!b) return; b.pop = 1; var wp = [Math.cos(b.ang)*b.r, b.y, Math.sin(b.ang)*b.r]; flyTo(wp); showLetter(b); };

  /* 相机飞向某个漂流瓶 */
  var fly = null;
  function flyTo(pos, wantDist){
    var b = camBasis();
    fly = {
      t: 0, dur: 0.5,
      fromT: [target[0], target[1], target[2]], toT: [pos[0], pos[1], pos[2]],
      fromD: dist, toD: (wantDist || 34),
      fromYaw: yaw, toYaw: Math.atan2(pos[0], pos[2]) + 0.25,
      fromPitch: pitch, toPitch: 0.02
    };
  }
  function stepFly(dt){
    if(!fly) return;
    fly.t += dt / fly.dur;
    var k = fly.t >= 1 ? 1 : (fly.t < 0.5 ? 2*fly.t*fly.t : 1 - Math.pow(-2*fly.t + 2, 2)/2);
    target[0] = fly.fromT[0] + (fly.toT[0] - fly.fromT[0]) * k;
    target[1] = fly.fromT[1] + (fly.toT[1] - fly.fromT[1]) * k;
    target[2] = fly.fromT[2] + (fly.toT[2] - fly.fromT[2]) * k;
    dist = fly.fromD + (fly.toD - fly.fromD) * k;
    yaw = fly.fromYaw + (fly.toYaw - fly.fromYaw) * k;
    pitch = fly.fromPitch + (fly.toPitch - fly.fromPitch) * k;
    if(fly.t >= 1) fly = null;
  }

  /* 纸质信纸 */
  function showLetter(bo){
    var el = document.getElementById('teStarLetter');
    if(!el){
      el = document.createElement('div');
      el.id = 'teStarLetter';
      el.className = 'st-letter-ov';
      el.innerHTML = '<div class="st-letter">' +
        '<div class="st-paper">' +
          '<i class="st-wax"></i>' +
          '<div class="st-cap"></div>' +
          '<div class="st-body"></div>' +
          '<div class="st-date"></div>' +
        '</div>' +
        '<div class="st-lrow"><div class="st-lbtn">收好，放回海里</div><div class="st-ldel">删除这只瓶子</div></div>' +
      '</div>';
      document.getElementById('p-star').appendChild(el);
      el.addEventListener('click', function(ev){
        var cn = String(ev.target.className || '');
        if(cn.indexOf('st-ldel') >= 0){
          try{
            var w = el.__wish && el.__wish.wish;
            var ws = wishesLoad(), at = -1;
            if(w){
              for(var wi = 0; wi < ws.length; wi++){
                if(ws[wi] === w || (ws[wi].t === w.t && ws[wi].at === w.at)){ at = wi; break; }
              }
            }
            if(at >= 0){
              ws.splice(at, 1); wishesSave(ws); rebuildBottles();
              try{ toast('这只瓶子已经还给海了'); }catch(e){}
            } else { try{ toast('这只瓶子已经不在海里了'); }catch(e){} }
          }catch(e){}
          el.classList.remove('on');
          return;
        }
        if(ev.target === el || cn.indexOf('st-lbtn') >= 0) el.classList.remove('on');
      });
    }
    var w = bo.wish;
    el.__wish = bo;
    el.querySelector('.st-cap').textContent = w ? (w.from === 'ai' ? 'TA 写下的心愿' : '我许下的心愿') : '一只空瓶子';
    el.querySelector('.st-body').textContent = w ? w.t : '海水把它磨得温温的，里面什么也没写。';
    var dt = w && w.at ? new Date(w.at) : null;
    el.querySelector('.st-date').textContent = dt ? (dt.getFullYear() + '.' + (dt.getMonth()+1) + '.' + dt.getDate()) : '';
    el.classList.add('on');
  }

  /* 许愿输入（纸质） */
  window.teStarWishAsk = function(){
    var el = document.getElementById('teStarWishBox');
    if(!el){
      el = document.createElement('div');
      el.id = 'teStarWishBox';
      el.className = 'st-letter-ov';
      el.innerHTML = '<div class="st-letter">' +
        '<div class="st-paper st-paper-write">' +
          '<div class="st-cap">Make a wish</div>' +
          '<textarea class="st-input" maxlength="300" placeholder="Write something to the sea…"></textarea>' +
          '<div class="st-row"><div class="st-cancel">算了</div><div class="st-ok">放进海里</div></div>' +
        '</div>' +
      '</div>';
      document.getElementById('p-star').appendChild(el);
      el.addEventListener('click', function(ev){ if(ev.target === el) el.classList.remove('on'); });
      el.querySelector('.st-cancel').onclick = function(){ el.classList.remove('on'); };
      el.querySelector('.st-ok').onclick = function(){
        var v = String(el.querySelector('.st-input').value || '').trim();
        if(!v){ try{ toast('还没写呢'); }catch(e){} return; }
        var ws = wishesLoad();
        ws.push({ t: v, at: Date.now(), from: 'me', injected: 0 });
        wishesSave(ws);
        el.querySelector('.st-input').value = '';
        el.classList.remove('on');
        rebuildBottles();
        ripple([0, -20, 0], true);
        try{ toast('心愿已经放进海里 ♡'); }catch(e){}
      };
    }
    el.classList.add('on');
    setTimeout(function(){ var t = el.querySelector('.st-input'); if(t) t.focus(); }, 120);
  };

  /* ---------- 渲染 ---------- */
  function resize(){
    if(!canvas) return;
    /* ★ 12.39（用户：「星海进去还是一片黑」）：
       以前 clientWidth 为 0 时就直接退成 1px —— 进了页面只量到 1×1 的缓冲，
       整片星空画进那一个像素，屏幕当然全黑；而且之后只在 window.resize 时才重量，
       手机不转屏就永远黑着。
       现在：没有 CSS 尺寸就按视口算，至少保证是一块满屏的缓冲。 */
    var w = canvas.clientWidth || 0, h = canvas.clientHeight || 0;
    if(!w || !h){
      w = window.innerWidth || document.documentElement.clientWidth || 360;
      h = window.innerHeight || document.documentElement.clientHeight || 640;
    }
    var pw = Math.max(1, Math.round(w * DPR)), ph = Math.max(1, Math.round(h * DPR));
    if(canvas.width !== pw || canvas.height !== ph){ canvas.width = pw; canvas.height = ph; }
  }
  function colorFor(k, r, out){
    /* k: 0 亮星 1 次亮 2 暗星 3 记忆星 4 特效 */
    if(k < 3){
      var c = k === 0 ? palette.starA : (k === 1 ? palette.starB : palette.starC);
      out[0] = c[0]; out[1] = c[1]; out[2] = c[2];
      var br = k === 0 ? 1 : (k === 1 ? 0.82 : 0.6);
      out[0] *= br; out[1] *= br; out[2] *= br;
    } else if(k === 3){
      var m = palette.memA; out[0] = m[0]; out[1] = m[1]; out[2] = m[2];
    } else {
      var f = palette.fx; out[0] = f[0]; out[1] = f[1]; out[2] = f[2];
    }
    return out;
  }
  var tmpCol = [0, 0, 0];
  function disableUnused(prog){
    var used = {};
    for(var k in prog._a){ used[prog._a[k]] = 1; }
    for(var i = 0; i < 4; i++){ try{ if(!used[i]) gl.disableVertexAttribArray(i); }catch(e){} }
  }
  function drawPoints(set, alpha, time, additive){
    if(!set || !set.count || !set.buf) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, set.buf.pos); gl.enableVertexAttribArray(progPoint._a.aPos); gl.vertexAttribPointer(progPoint._a.aPos, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, set.buf.col); gl.enableVertexAttribArray(progPoint._a.aCol); gl.vertexAttribPointer(progPoint._a.aCol, 4, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, set.buf.siz); gl.enableVertexAttribArray(progPoint._a.aSize); gl.vertexAttribPointer(progPoint._a.aSize, 1, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.POINTS, 0, set.count);
  }
  /* 颜色档位在 CPU 侧映射：把 col.x 当"档位"，逐帧写进一个临时缓冲代价高，
     所以这里把三档星色直接烘焙进属性（初始化时用当时调色板，主题变化时重烘焙）。 */
  function bakeColors(set){
    if(!set || !set.buf) return;
    var n = set.count, arr = new Float32Array(n * 4);
    for(var i = 0; i < n; i++){
      var k = set.col[i*4], r = set.col[i*4+1], kk = k | 0;
      colorFor(kk, r, tmpCol);
      var br = kk === 0 ? (0.75 + r * 0.25) : (kk === 1 ? (0.6 + r * 0.4) : (0.35 + r * 0.5));
      arr[i*4] = tmpCol[0] * br; arr[i*4+1] = tmpCol[1] * br; arr[i*4+2] = tmpCol[2] * br;
      /* 保留每颗星的随机相位：buildStars 里 col[i*4+3] = Math.random()，
         之前被烘焙成 1，导致闪烁相位全同步 → 整屏像坏掉的日光灯 */
      arr[i*4+3] = set.col[i*4+3];
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, set.buf.col); gl.bufferData(gl.ARRAY_BUFFER, arr, gl.STATIC_DRAW);
  }
  function bakeFx(){
    var n = fx.max, arr = new Float32Array(n * 4);
    for(var i = 0; i < n; i++){
      arr[i*4] = fx.col[i*4+1] || 0.8; arr[i*4+1] = fx.col[i*4+2] || 0.8; arr[i*4+2] = fx.col[i*4+3] || 0.9;
      arr[i*4+3] = fx.life[i] > 0 ? fx.life[i] : 0;
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, fx.buf.col); gl.bufferData(gl.ARRAY_BUFFER, arr, gl.DYNAMIC_DRAW);
  }

  var lastBakeHue = null;
  var frameCount = 0, _lastFrameAt = 0, _starKicked = 0;
  function frame(now){
    if(!running) return;
    frameCount++;
    raf = requestAnimationFrame(frame);
    var t = (now - time0) / 1000;
    var rdt = _lastFrameAt ? Math.min(0.06, Math.max(0.008, (now - _lastFrameAt) / 1000)) : 0.016;
    _lastFrameAt = now;

    /* 自适应画质：帧时间用指数平均滤波，超预算就减星、宽裕就加回。
       手机性能差异极大，写死上限必然要么卡要么糊 */
    _ftEma = _ftEma * 0.88 + (rdt * 1000) * 0.12;
    if(_ftEma > 25 && drawBudget > 2600) drawBudget = Math.max(2600, drawBudget - 100);
    else if(_ftEma < 17.5 && drawBudget < 9000) drawBudget = Math.min(9000, drawBudget + 40);

    /* 主题色跟随 */
    var hue = themeHue();
    if(hue !== lastBakeHue){
      lastBakeHue = hue;
      palette = buildPalette();
      tintCache = {};                         /* 原来不清缓存：换主题色时星空不变色 */
      if(!use2D){ try{ bakeColors(galaxy); bakeColors(halo); bakeColors(memStars); }catch(e){} }
    }
    if(!palette) palette = buildPalette();
    /* 昼夜过渡 */
    var want = (mode === 'day') ? 0 : 1;
    if(Math.abs(modeT - want) > 0.02){
      /* 朝目标走一步。原来写成 want + 符号*0.2，白天（want=0）时算出的永远是 0.2，
         modeT 从 1 一步跳到 0.2 就卡住了 —— 白天永远差最后一段没过渡完，
         所以"白天固定画面"那套只生效了一部分。 */
      var step = modeT + (want > modeT ? 0.2 : -0.2);
      modeT = (want === 1) ? Math.min(want, step) : Math.max(want, step);
      palette = modeT > 0.5 ? buildPalette() : dayPalette();
      if(!palette) palette = buildPalette();
      tintCache = {};
      if(!use2D){ try{ bakeColors(galaxy); bakeColors(halo); bakeColors(memStars); }catch(e){} }
    }

    /* 惯性 + 自走镜头：用户不碰的时候，镜头自己慢慢巡航，星海才像在"活着"。
       全部按 dt 计算 —— 原来写死每帧加 0.0013，在 120Hz 屏上会快一倍 */
    if(!drag){
      yaw += vYaw; pitch = Math.max(-1.25, Math.min(1.25, pitch + vPitch));
      vYaw *= 0.955; vPitch *= 0.94;
      if(!(quietMotion && quietMotion.matches) && now - lastUserAt > 1400){            /* 松手一会儿后才接管，不跟用户抢手感 */
        yaw += 0.0055 * rdt * (1 + 0.30 * Math.sin(t * 0.083));
        pitch = Math.max(-1.25, Math.min(1.25, pitch + Math.sin(t * 0.055) * 0.004 * rdt));
        if(!fly) dist = Math.max(24, Math.min(700, dist + Math.sin(t * 0.037) * 0.30 * rdt));
      }
    }

    stepFly(rdt);
    /* 粒子寿命/位移推进（GL 与 2D 都要走这里，否则粒子会一直挂在屏幕上） */
    if(fx.pos){
      var fdt = rdt;
      for(var fi = 0; fi < fx.max; fi++){
        if(fx.life[fi] > 0){
          fx.life[fi] -= fdt;
          fx.pos[fi*3] += fx.vel[fi*3] * fdt; fx.pos[fi*3+1] += fx.vel[fi*3+1] * fdt; fx.pos[fi*3+2] += fx.vel[fi*3+2] * fdt;
          fx.vel[fi*3] *= 0.93; fx.vel[fi*3+1] *= 0.93; fx.vel[fi*3+2] *= 0.93;
        }
      }
    }
    /* ★ 12.36（用户：「星海进去一片黑/空」）：
       以前 resize() 只在 **WebGL 分支**里调；可默认走的是 Canvas2D 兜底
       （initGL 里 `if(!window.TE_STAR_USE_GL){ to2D(); return false; }`），
       2D 这条路**从来没给自己量过尺寸** → canvas 一直是默认 300×150（或 0×0），
       往一个错尺寸的缓冲里画，屏幕上看就是一片黑。
       现在先量尺寸，再分 GL / 2D 两条路。 */
    /* ★ 12.39：每 64 帧再量一次尺寸（一次 clientWidth 读取，代价可以忽略）。
       进页面那一下如果正好在动画/隐藏状态（尺寸 0×0 或者 300×150），
       这里有 1 秒内自愈的机会 —— 不用等用户转屏/按返回再进。 */
    if((frameCount & 63) === 0) resize();
    if(use2D){ render2D(t); return; }
    var w = canvas.width, h = canvas.height;
    var aspect = w / Math.max(1, h);
    var proj = perspective(52 * Math.PI / 180, aspect, 1, 2200);
    var eye = camEye();
    var view = lookAt(eye, target, [0, 1, 0]);
    var vp = mul(proj, view);

    var bgc = modeT > 0.5 ? palette.bg : dayPalette().bg;
    if(modeT <= 0.5){ var d = dayPalette().bg; bgc = [lerp(d[0], palette.bg[0], modeT*2), lerp(d[1], palette.bg[1], modeT*2), lerp(d[2], palette.bg[2], modeT*2)]; }
    gl.viewport(0, 0, w, h);
    gl.clearColor(bgc[0], bgc[1], bgc[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    var additive = modeT > 0.5;
    gl.enable(gl.BLEND);
    if(additive) gl.blendFunc(gl.ONE, gl.ONE);
    else gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    gl.useProgram(progPoint);
    disableUnused(progPoint);
    gl.uniformMatrix4fv(progPoint._u.uVP, false, vp);
    gl.uniform3fv(progPoint._u.uCam, new Float32Array(eye));
    gl.uniform1f(progPoint._u.uTime, t);
    gl.uniform1f(progPoint._u.uDpr, DPR);

    /* 星尘拖尾（GL 分支的绘制；粒子的寿命推进在共享部分做过了） */
    if(fx.head >= 0){
      gl.bindBuffer(gl.ARRAY_BUFFER, fx.buf.pos); gl.bufferData(gl.ARRAY_BUFFER, fx.pos, gl.DYNAMIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, fx.buf.col); gl.bufferData(gl.ARRAY_BUFFER, fx.col, gl.DYNAMIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, fx.buf.siz); gl.bufferData(gl.ARRAY_BUFFER, fx.size, gl.DYNAMIC_DRAW);
      gl.enableVertexAttribArray(progPoint._a.aPos); gl.bindBuffer(gl.ARRAY_BUFFER, fx.buf.pos); gl.vertexAttribPointer(progPoint._a.aPos, 3, gl.FLOAT, false, 0, 0);
      gl.enableVertexAttribArray(progPoint._a.aCol); gl.bindBuffer(gl.ARRAY_BUFFER, fx.buf.col); gl.vertexAttribPointer(progPoint._a.aCol, 4, gl.FLOAT, false, 0, 0);
      gl.enableVertexAttribArray(progPoint._a.aSize); gl.bindBuffer(gl.ARRAY_BUFFER, fx.buf.siz); gl.vertexAttribPointer(progPoint._a.aSize, 1, gl.FLOAT, false, 0, 0);
      gl.drawArrays(gl.POINTS, 0, fx.max);
    }

    drawPoints(halo, 0.5, t);
    drawPoints(galaxy, 1.0, t);
    drawPoints(memStars, 1.0, t);

    /* 光线：沿曲线撒亮点（复用常驻缓冲） */
    if(rays && rays.length && rayBuf){
      var RP = rayBuf.rp, RC = rayBuf.rc, RS = rayBuf.rs;
      var p = 0;
      for(var r = 0; r < rays.length; r++){
        var ry = rays[r], flow = (t * ry.speed + ry.phase) % 1;
        for(var k = 0; k < ry.pts.length; k++){
          var q = ry.pts[k], tt = k / (ry.pts.length - 1);
          var glow = Math.exp(-Math.pow((tt - flow) * 7.0, 2)) * 0.9 + 0.16;
          RP[p*3] = q[0]; RP[p*3+1] = q[1]; RP[p*3+2] = q[2];
          RC[p*4] = palette.ray[0]; RC[p*4+1] = palette.ray[1]; RC[p*4+2] = palette.ray[2]; RC[p*4+3] = glow;
          RS[p] = 0.7 + glow * 1.8;
          p++;
        }
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, rayBuf.pos); gl.bufferData(gl.ARRAY_BUFFER, RP.subarray(0, p*3), gl.STREAM_DRAW);
      gl.enableVertexAttribArray(progPoint._a.aPos); gl.vertexAttribPointer(progPoint._a.aPos, 3, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, rayBuf.col); gl.bufferData(gl.ARRAY_BUFFER, RC.subarray(0, p*4), gl.STREAM_DRAW);
      gl.enableVertexAttribArray(progPoint._a.aCol); gl.vertexAttribPointer(progPoint._a.aCol, 4, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, rayBuf.siz); gl.bufferData(gl.ARRAY_BUFFER, RS.subarray(0, p), gl.STREAM_DRAW);
      gl.enableVertexAttribArray(progPoint._a.aSize); gl.vertexAttribPointer(progPoint._a.aSize, 1, gl.FLOAT, false, 0, 0);
      gl.drawArrays(gl.POINTS, 0, p);
    }

    /* 云团 */
    gl.useProgram(progNeb);
    disableUnused(progNeb);
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
    gl.enableVertexAttribArray(progNeb._a.aUv); gl.vertexAttribPointer(progNeb._a.aUv, 2, gl.FLOAT, false, 0, 0);
    gl.uniformMatrix4fv(progNeb._u.uVP, false, vp);
    gl.uniform1f(progNeb._u.uTime, t);
    for(var nidx = 0; nidx < nebulas.length; nidx++){
      var nb = nebulas[nidx];
      var tint = palette[nb.tint] || palette.nebA;
      gl.uniform3fv(progNeb._u.uCenter, new Float32Array(nb.c));
      gl.uniform3fv(progNeb._u.uRight, new Float32Array([Math.cos(yaw), 0, -Math.sin(yaw)]));
      gl.uniform3fv(progNeb._u.uUp, new Float32Array([0, 1, 0]));
      gl.uniform1f(progNeb._u.uSize, nb.size);
      gl.uniform3fv(progNeb._u.uTint, new Float32Array([tint[0], tint[1], tint[2]]));
      var nebD = Math.hypot(nb.c[0] - eye[0], nb.c[1] - eye[1], nb.c[2] - eye[2]);
      gl.uniform1f(progNeb._u.uAlpha, nb.a * (modeT > 0.5 ? 1 : 0.75) * Math.max(0.25, Math.min(1.0, 240 / Math.max(60, nebD))));
      gl.uniform2fv(progNeb._u.uSeed, new Float32Array(nb.seed));
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }

    /* 记忆标签跟随 */
    if(labels.length){
      for(var li = 0; li < labels.length; li++){
        var L = labels[li], i3 = L.i * 3;
        var wx = (memStars.pos[i3] * 0), wy = 0, wz = 0;
        wx = memStars.pos[i3]; wy = memStars.pos[i3+1]; wz = memStars.pos[i3+2];
        var v = view, x = v[0]*wx + v[4]*wy + v[8]*wz + v[12], y = v[1]*wx + v[5]*wy + v[9]*wz + v[13], z = v[2]*wx + v[6]*wy + v[10]*wz + v[14];
        if(z > -2){ L.el.style.opacity = 0; continue; }
        var pr = proj, cx = pr[0]*x + pr[8]*z, cy = pr[5]*y + pr[9]*z, cw = -z;
        var sx = (cx / cw * 0.5 + 0.5) * canvas.clientWidth, sy = (1 - (cy / cw * 0.5 + 0.5)) * canvas.clientHeight;
        if(sx < -80 || sx > canvas.clientWidth + 80 || sy < -40 || sy > canvas.clientHeight + 40){ L.el.style.opacity = 0; continue; }
        L.el.style.left = sx + 'px'; L.el.style.top = sy + 'px';
        L.el.style.opacity = (modeT > 0.5 ? 0.92 : 0.9) * Math.max(0.25, Math.min(1, 1 - cw / 620));
      }
    }
  }

  /* ---------- 对外接口 ---------- */
  window.teStarEnter = function(){
    if(!ready){
      try{ ready = initGL(); }catch(e){ ready = false; }
      if(ready) bindInput();
      else if(use2D){ ready = true; }          /* 2D 兜底：数据已就绪，直接开画 */
    }
    if(!ready) return;
    try{ document.body.classList.add('te-star'); }catch(e){}
    try{ if(window.teSndStarIn) window.teSndStarIn(); }catch(e){}
    try{ if(window.teSndAmb) window.teSndAmb('star'); }catch(e){}
    running = true; time0 = performance.now();
    try{ cancelAnimationFrame(raf); }catch(e){}
    palette = buildPalette(); lastBakeHue = themeHue();
    bakeColors(galaxy); bakeColors(halo); bakeColors(memStars);
    var day = document.body.classList.contains('te-star-day');
    mode = day ? 'day' : 'night'; modeT = day ? 0 : 1;
    if(day) palette = lerpPal(palette, dayPalette(), 1);
    var b = document.getElementById('teStarDay'); if(b) b.innerHTML = day ? STAR_ICONS.sun : STAR_ICONS.moon;
    raf = requestAnimationFrame(frame);
    /* ★ 12.39：进页面这一帧量到的尺寸可能是 0（页面刚 .on、还在动画里、或者被家园/星露谷
       那两层盖着）。以前只在 window.resize 时重量 → 手机不转屏就永远是那个错尺寸。
       现在连量几次；如果 2.4 秒后一帧都没画出来，就把 2D 兜底重起一遍并报进徽章。 */
    try{ resize(); }catch(e){}
    [0, 90, 260, 620, 1200].forEach(function(ms){
      setTimeout(function(){ try{ if(running) resize(); }catch(e){} }, ms);
    });
    var _f0 = frameCount;
    setTimeout(function(){
      try{
        if(!running) return;
        var badCv = !canvas || canvas.width < 8 || canvas.height < 8;
        if((frameCount === _f0 || badCv) && !_starKicked){
          _starKicked = 1;
          try{ window.__starErr = (frameCount === _f0 ? '2.4s 一帧都没画' : ('画布 ' + (canvas?canvas.width+'x'+canvas.height:'无'))); }catch(e){}
          try{
            if(window.parent && window.parent.__teErrAdd) window.parent.__teErrAdd('[星海] ' + window.__starErr + '，已重起 2D 兜底', 'cv ' + (canvas?canvas.width+'x'+canvas.height:'无'));
          }catch(e){}
          try{ running = false; use2D = false; ready = false; to2D(); ready = true; window.teStarEnter(); }catch(e){}
        }
      }catch(e){}
    }, 2400);
  };
  window.teStarLeave = function(){
    try{ document.body.classList.remove('te-star'); }catch(e){}
    try{ if(window.teSndAmb) window.teSndAmb(null); }catch(e){} running = false; _starKicked = 0; try{ cancelAnimationFrame(raf); }catch(e){} };
  window.teStarToggleDay = function(){
    var day = !document.body.classList.contains('te-star-day');
    document.body.classList.toggle('te-star-day', day);
    mode = day ? 'day' : 'night';
    var b = document.getElementById('teStarDay'); if(b) b.innerHTML = day ? STAR_ICONS.sun : STAR_ICONS.moon;
    applyGlow(glowIdx);                      /* 顺手把星光按钮的图标同步上 */
    try{ if(typeof toast === 'function') toast(day ? '白日 · 星海' : '夜深了，星星亮了'); }catch(e){}
  };
  window.teStarCycleGlow = function(){
    applyGlow((glowIdx + 1) % GLOW_PRESETS.length);
    try{ if(typeof toast === 'function') toast('星光 · ' + GLOW_PRESETS[glowIdx].name); }catch(e){}
  };
  window.teStarGlow = function(i){ if(i === undefined) return glowIdx; applyGlow(i); return glowIdx; };
  window.teStarReset = function(){
    target = [0, 0, 0]; dist = 112; yaw = 0.6; pitch = 0.16; vYaw = 0.02; vPitch = 0.004;
  };
  window.__starWS = function(x, y){ return worldFromScreen(x, y); };
  window.__starProj = function(w){ var vw = canvas.clientWidth, vh = canvas.clientHeight; var proj = perspective(52*Math.PI/180, vw/Math.max(1,vh), 1, 2200); return projStar(w[0], w[1], w[2], lookAt(camEye(), target, [0,1,0]), proj, vw, vh); };
  window.__starDbg = function(){
    return { use2D: use2D, running: running, ready: ready, built: sceneBuilt, frames: frameCount,
             stars: galaxy ? galaxy.count : 0, halo: halo ? halo.count : 0,
             cv: canvas ? [canvas.width, canvas.height, canvas.clientWidth, canvas.clientHeight] : null,
             ctx2d: !!ctx2d, boats: boats.length,
             bottles: bottles.map(function(b){ return [Math.round(b._sx||-999), Math.round(b._sy||-999)]; }),
             pool: _lastPoolN, drawn: _lastDrawnN, budget: drawBudget, ftEma: Math.round(_ftEma * 10) / 10,
             meteors: meteors.length, dist: Math.round(dist), target: target.map(Math.round), fly: !!fly, canvasCss: canvas ? [canvas.clientWidth, canvas.clientHeight] : null };
  };
  window.teStarInit = function(){ if(!ready){ ready = initGL(); if(ready) bindInput(); } };
  function bindLost(){
    if(!canvas || canvas.__starLostBound) return;
    canvas.__starLostBound = 1;
    canvas.addEventListener('webglcontextlost', function(e){
      try{ e.preventDefault(); }catch(x){}
      running = false; ready = false;
      /* 换一块新画布，等 GPU 缓过来再重建 */
      try{
        var nc = canvas.cloneNode(false);
        nc.id = canvas.id;
        canvas.parentNode.replaceChild(nc, canvas);
        canvas = nc; gl = null;
      }catch(x){}
      setTimeout(function(){ try{ to2D(); if(document.getElementById('p-star').classList.contains('on')) window.teStarEnter(); }catch(x){} }, 300);
    }, false);
    canvas.addEventListener('webglcontextrestored', function(){ ready = false; window.teStarEnter(); }, false);
  }
  window.teStarRebuild = function(){ if(ready){ buildMemories(); bakeColors(memStars); } };

  /* 离开页面就停渲染；回到页面再继续 */
  var _nav = window.nav;
  if(typeof _nav === 'function' && !_nav.__starWrapped){
    var wrapped = function(p){
      var r = _nav.apply(this, arguments);
      try{
        if(p === 'star') window.teStarEnter();
        else if(document.getElementById('p-star') && document.getElementById('p-star').classList.contains('on') === false) window.teStarLeave();
      }catch(e){}
      return r;
    };
    wrapped.__starWrapped = true;
    window.nav = wrapped;
  }
  document.addEventListener('visibilitychange', function(){
    if(document.hidden) window.teStarLeave();
    else if(document.getElementById('p-star') && document.getElementById('p-star').classList.contains('on')) window.teStarEnter();
  });
  window.addEventListener('resize', function(){ if(running) resize(); });

  /* 星海：进入页面时才初始化（避免每次开 App 都生成一遍星空） */
})();
