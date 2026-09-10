export const launcherCss = `
:root{font:15px/1.5 system-ui;color:#202321;background:#f5f6f3}
*{box-sizing:border-box}body{margin:0}
header{display:flex;flex-wrap:wrap;align-items:center;gap:12px;padding:14px 24px;background:white;border-bottom:1px solid #dadfd7}
header>strong{margin-right:auto;letter-spacing:.02em}header strong span{font-size:11px;margin-left:8px;background:#d4ff57;padding:4px 6px;border-radius:3px}
button,input{font:inherit;color:inherit;border:1px solid #cdd3c9;border-radius:6px;background:white}
button{padding:8px 12px;cursor:pointer}button:disabled{opacity:.5;cursor:wait}button:focus-visible,input:focus-visible{outline:3px solid #4d794f;outline-offset:2px}
.players{display:flex;gap:4px}.players button[aria-pressed="true"]{background:#202321;color:white}
.notice{padding:10px 24px;background:#ecf0e5;color:#52594e;font-size:13px}
main{display:grid;grid-template-columns:minmax(0,1fr) 340px;height:calc(100dvh - 136px);min-height:480px}
#frame-slot,iframe,#game{height:100%;width:100%;border:0;background:#151a16}
aside{overflow:auto;border-left:1px solid #dadfd7;background:#fff}.panel-section{padding:20px;border-bottom:1px solid #e2e5dd}
h1,h2{font-size:16px;margin:0 0 12px}h1{font-size:22px;letter-spacing:-.03em}.eyebrow{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:#67705f;margin:0 0 4px}
p{margin:0 0 10px}.hint,.empty,#status{font-size:13px;color:#67705f}.empty{margin-bottom:0}
.balances{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:18px}.balances div{padding:10px;background:#f2f5ee;border-radius:6px}.balances span{display:block;font-size:12px;color:#67705f}.balances strong{display:block;font-size:18px}
label{display:block;font-size:13px;margin-bottom:6px}label span{float:right}input{width:100%;padding:8px 10px;margin-bottom:10px}
.pool-actions{display:grid;grid-template-columns:1fr 1fr;gap:8px}.pool-actions .primary{grid-column:1/-1}.pool-actions button{font-size:13px}
#transfer-feedback{margin:10px 0 0}#transfer-feedback[data-error="true"]{color:#ac2e24}
ol{padding-left:18px;font-size:13px;margin:0}li{padding-bottom:8px;overflow-wrap:anywhere}
.transactions{list-style:none;padding:0}.transactions li{padding:10px 0;border-bottom:1px solid #edf0e9}.transactions li:last-child{border:0;padding-bottom:0}.transactions strong,.transactions span{display:block}.transactions span{color:#67705f}.transactions details{font-size:11px;color:#67705f;margin-top:4px}.transactions summary{cursor:pointer}.transactions code{font-size:10px}
dialog{max-width:410px;width:calc(100% - 32px);padding:28px;border:1px solid #cdd3c9;border-radius:12px;box-shadow:0 16px 70px #0003}dialog::backdrop{background:#101a1266}.actions{display:flex;gap:12px;justify-content:flex-end;margin-top:24px}
.primary{background:#d4ff57;border-color:#b4df3d;font-weight:650}.paid{color:#23834b}.paid:before{content:'✓';display:inline-grid;place-items:center;width:36px;height:36px;background:#e1f3e6;border-radius:50%;margin-right:8px;animation:appear .25s ease-out}
@keyframes appear{from{transform:scale(.7);opacity:.2}}@media(prefers-reduced-motion:reduce){.paid:before{animation:none}}
@media(max-width:760px){main{display:block;height:auto}#game{height:60dvh;min-height:260px}aside{border-left:0}header{padding:12px;gap:8px}header>strong{width:100%}header button{font-size:13px;padding:7px 9px}.notice{padding:10px 12px}.panel-section{padding:18px}}
`;
