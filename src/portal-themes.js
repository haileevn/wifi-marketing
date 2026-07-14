/** CSS bổ sung theo template_id — layout + typography trên portal thật */
const THEMES = {
  classic: `
.theme-classic .brand h1{font-family:Georgia,"Times New Roman",serif}
.theme-classic .form-head h2{font-weight:800}
`,
  dark: `
.theme-dark .brand{background:linear-gradient(160deg,#0a0a14 0%,var(--accent-dark) 55%,#1a1a2e 100%)}
.theme-dark .main{background:#12121f}
.theme-dark .form-shell .field label{color:#e8e8f0}
.theme-dark .input-wrap,.theme-dark .field>input,.theme-dark .field>select{background:#1a1a2e;border-color:#2d2d44;color:#f0f0f8}
.theme-dark .form-head h2{color:#f5f5ff;font-family:"SF Pro Display",-apple-system,sans-serif;letter-spacing:-.03em}
.theme-dark .btn-submit{box-shadow:0 8px 24px rgba(0,0,0,.45)}
`,
  fresh: `
.theme-fresh .brand{border-radius:0 0 32px 32px}
.theme-fresh .logo-wrap{border-radius:24px}
.theme-fresh :root{--radius:20px}
.theme-fresh .form-head h2{font-family:"Avenir Next",Avenir,-apple-system,sans-serif;font-weight:700}
.theme-fresh .wifi-badge{background:rgba(255,255,255,.28)}
`,
  ocean: `
.theme-ocean .brand{background:linear-gradient(165deg,#0c4a6e 0%,var(--accent) 50%,#38bdf8 100%)}
.theme-ocean .brand::before{opacity:.25;background:repeating-linear-gradient(-45deg,transparent,transparent 12px,rgba(255,255,255,.06) 12px,rgba(255,255,255,.06) 24px)}
.theme-ocean .form-head h2{font-weight:700;letter-spacing:-.01em}
.theme-ocean .btn-submit{border-radius:999px}
.theme-ocean .wifi-badge{border-radius:12px;text-transform:none;letter-spacing:0}
`,
  sunset: `
.theme-sunset .brand{background:linear-gradient(150deg,#7c2d12 0%,var(--accent) 40%,#fbbf24 120%)}
.theme-sunset .brand h1{font-family:Palatino,"Palatino Linotype",Georgia,serif;font-weight:700}
.theme-sunset .form-head .step{color:#c2410c}
.theme-sunset .promo{border-style:solid;border-color:rgba(255,255,255,.35)}
`,
  minimal: `
.theme-minimal .brand{background:var(--card);color:var(--ink);border-bottom:1px solid var(--line)}
.theme-minimal .brand::before{display:none}
.theme-minimal .wifi-badge{background:var(--bg);color:var(--ink);border:1px solid var(--line)}
.theme-minimal .brand h1{font-size:20px;font-weight:600;letter-spacing:.02em;text-transform:uppercase}
.theme-minimal .tagline{font-weight:400;opacity:.7}
.theme-minimal .logo-wrap{box-shadow:none;border:1px solid var(--line)}
.theme-minimal .brand-features{display:none}
.theme-minimal .form-head h2{font-size:18px;font-weight:600;letter-spacing:.04em;text-transform:uppercase}
.theme-minimal .btn-submit{background:var(--ink);box-shadow:none;border-radius:8px}
.theme-minimal :root{--radius:8px}
`,
};

function themeCss(templateId) {
  const id = String(templateId || "classic").toLowerCase();
  return THEMES[id] || THEMES.classic;
}

module.exports = { themeCss, THEMES };
