export type NameAsrPhase = 'idle' | 'permission' | 'recording' | 'transcribing';
type Callbacks = { beforeStart(): void; onState(phase: NameAsrPhase): void; onStatus(message: string, error?: boolean): void; onResult(text: string): void };

export function mountNameAsr(button: HTMLButtonElement, cancelButton: HTMLButtonElement, callbacks: Callbacks) {
 const lifetime = new AbortController();
 const label = document.getElementById('asrLabel')!, clock = document.getElementById('asrClock')!;
 let phase: NameAsrPhase = 'idle', version = 0;
 let recorder: MediaRecorder | null = null, stream: MediaStream | null = null, upload: AbortController | null = null;
 let timer: ReturnType<typeof setTimeout> | null = null, ticker: ReturnType<typeof setInterval> | null = null;
 const capable = !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== 'undefined';
 function state(next: NameAsrPhase) {
  phase = next; button.classList.toggle('is-recording', phase === 'recording');
  button.setAttribute('aria-pressed', String(phase === 'recording'));
  button.disabled = !capable || phase === 'permission' || phase === 'transcribing';
  cancelButton.hidden = phase === 'idle'; clock.hidden = phase !== 'recording';
  label.textContent = ({ idle:'说出名字', permission:'正在打开麦克风…', recording:'说完了，点这里', transcribing:'正在识别…' })[phase];
  callbacks.onState(phase);
 }
 function clearTimers() { if (timer) clearTimeout(timer); if (ticker) clearInterval(ticker); timer = null; ticker = null; }
 function releaseMic() { stream?.getTracks().forEach(t => t.stop()); stream = null; }
 function cancel(message?: string) {
  version++; clearTimers(); upload?.abort(); upload = null;
  if (recorder) { recorder.ondataavailable = null; recorder.onstop = null; recorder.onerror = null; if (recorder.state !== 'inactive') recorder.stop(); }
  recorder = null; releaseMic(); state('idle');
  if (message) callbacks.onStatus(message);
 }
 function finish() { if (phase === 'recording' && recorder?.state === 'recording') { clearTimers(); recorder.stop(); state('transcribing'); } }
 async function start() {
  if (!capable) { callbacks.onStatus('当前浏览器不能录音，可以直接打字。', true); return; }
  cancel(); callbacks.beforeStart(); const mine = version;
  state('permission'); callbacks.onStatus('请允许麦克风，然后只说出想起的名字。');
  timer = setTimeout(() => { if (mine === version) { cancel(); callbacks.onStatus('还没打开麦克风。可以重试，或直接打字。',true); } }, 15000);
  try {
   const acquired = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation:true, noiseSuppression:true, channelCount:1 }, video:false });
   if (mine !== version) { acquired.getTracks().forEach(t=>t.stop()); return; }
   clearTimers(); stream = acquired;
   const mime = ['audio/webm;codecs=opus','audio/mp4','audio/ogg;codecs=opus','audio/webm'].find(t=>MediaRecorder.isTypeSupported(t));
   if (!mime) throw new Error('录音格式暂时不支持，可以直接打字。');
   const recording = new MediaRecorder(acquired, {mimeType:mime,audioBitsPerSecond:64000});
   recorder = recording; let chunks: Blob[] = [], bytes = 0;
   recording.ondataavailable = event => {
    if (mine !== version || !event.data.size) return;
    chunks.push(event.data); bytes += event.data.size;
    if (bytes > 1024 * 1024) { cancel(); callbacks.onStatus('这段录音有点长，重新说一个名字吧。',true); }
   };
   recording.onerror = () => { if (mine === version) { cancel(); callbacks.onStatus('这次没录好，可以重试或直接打字。',true); } };
   recording.onstop = async () => {
    releaseMic(); clearTimers(); recorder = null;
    if (mine !== version) return;
    state('transcribing'); callbacks.onStatus('说完了，正在把名字变成文字…');
    upload = new AbortController(); const ctl = upload;
    timer = setTimeout(() => { if (mine === version) { cancel(); callbacks.onStatus('这次识别等得有点久，可以重试或打字。',true); } }, 40000);
    try {
     const blob = new Blob(chunks, {type:recording.mimeType}); chunks = [];
     if (!blob.size) throw new Error('没有录到声音，再说一次吧。');
     const response = await fetch('/api/naming/asr', {method:'POST',headers:{'Content-Type':recording.mimeType},body:blob,signal:ctl.signal});
     const body = await response.json();
     if (mine !== version) return;
     if (!response.ok || typeof body.text !== 'string' || !body.text.trim()) throw new Error(typeof body.detail === 'string' ? body.detail : '没有识别清楚，可以再说一次。');
     clearTimers(); upload = null; state('idle'); callbacks.onResult(body.text.trim());
    } catch (error) {
     if (mine !== version) return;
     cancel(); callbacks.onStatus(error instanceof Error ? error.message : '识别没有完成，可以重试或打字。',true);
    }
   };
   recording.start(250); state('recording'); const began = performance.now();
   clock.textContent = '0 / 12 秒';
   ticker = setInterval(()=>clock.textContent = `${Math.min(12,Math.floor((performance.now()-began)/1000))} / 12 秒`,200);
   timer = setTimeout(finish,12000);
   callbacks.onStatus('正在听。说完名字后，再点一下结束。');
  } catch (error) {
   if (mine !== version) return;
   cancel();
   const name = error instanceof DOMException ? error.name : '';
   callbacks.onStatus(name === 'NotAllowedError' ? '没有获得麦克风权限。可以允许后再试，或直接打字。' : name === 'NotFoundError' ? '没有找到麦克风，可以直接打字。' : error instanceof Error ? error.message : '麦克风暂时不可用，可以直接打字。',true);
  }
 }
 button.addEventListener('click', () => { if (phase === 'recording') finish(); else if (phase === 'idle') void start(); }, {signal:lifetime.signal});
 cancelButton.addEventListener('click', () => cancel('语音输入已取消，原来的名字还在。'), {signal:lifetime.signal});
 document.addEventListener('visibilitychange', () => { if (document.hidden && phase !== 'idle') cancel('语音输入已停止，可以重新说或打字。'); }, {signal:lifetime.signal});
 window.addEventListener('pagehide', () => cancel(), {signal:lifetime.signal});
 // No permission request is made until the microphone button is clicked.
 button.disabled = !capable;
 if (!capable) document.getElementById('asrNote')!.textContent = '当前浏览器不能录音，直接打字也可以。';
 return { cancel, destroy() { lifetime.abort(); cancel(); }, get active() { return phase !== 'idle'; }, get phase() { return phase; } };
}
