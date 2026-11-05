import { useEffect, useState } from 'react';
import { Copy, RefreshCw, Smartphone } from 'lucide-react';
import { api, onEvent } from '../api';
import { Button, Toggle, cx, toast } from './ui';

type RemoteInfo = {
  enabled: boolean;
  port: number;
  running: boolean;
  error: string;
  addresses: { name: string; address: string }[];
  address: string;
  url: string;
  qr: string;
  devices: { id: string; label: string; ip: string; streaming: boolean }[];
  tunnel: { enabled: boolean; available: boolean; status: 'off' | 'starting' | 'ready' | 'error'; url: string; error: string };
  qrFile: string;
  qrMirror: string;
};

/** Settings card: pair phones and tablets as microphones with a QR code. */
export function MobileCard() {
  const [info, setInfo] = useState<RemoteInfo | null>(null);
  const [busy, setBusy] = useState(false);

  const load = (address?: string) => api.get<RemoteInfo>(`/api/remote${address ? `?address=${encodeURIComponent(address)}` : ''}`).then(setInfo).catch(() => {});
  useEffect(() => { void load(); }, []);
  useEffect(() => onEvent((e) => {
    if (e.type === 'remote.devices') setInfo((cur) => (cur ? { ...cur, devices: e.devices } : cur));
    // A new tunnel address means a new QR code: reload it.
    if (e.type === 'remote.tunnel') void load();
  }), []);

  const post = async (body: any, msg?: string) => {
    setBusy(true);
    try {
      setInfo(await api.post<RemoteInfo>('/api/remote', { address: info?.address, ...body }));
      if (msg) toast(msg);
    } catch (e: any) {
      toast(e.message, { tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section id="movil" className="scroll-mt-6 rounded-2xl border border-hairline bg-raised">
      <div className="border-b border-hairline px-5 py-4">
        <div className="text-[14px] font-semibold text-ink">Móvil y tablet como micrófono</div>
        <div className="mt-0.5 text-[12.5px] text-ink-3">
          Escanea el código con la cámara del móvil y graba desde él: la transcripción aparece aquí en directo. Puedes conectar varios a la vez; cada uno sale con su nombre.
        </div>
      </div>
      <div className="divide-y divide-hairline">
        <div className="flex items-center gap-6 px-5 py-3.5">
          <div className="min-w-0 flex-1">
            <div className="text-[13px] text-ink">Aceptar micrófonos de la red local</div>
            <div className="mt-0.5 text-[12px] text-ink-4">El móvil tiene que estar en la misma wifi que este ordenador. Si Windows pregunta por el firewall, permite «Redes privadas».</div>
          </div>
          <Toggle checked={!!info?.enabled} onChange={(v) => void post({ enabled: v }, v ? 'Listo: escanea el código con el móvil' : 'Desactivado')} />
        </div>

        {info?.enabled && info.tunnel.available && (
          <div className="flex items-center gap-6 px-5 py-3.5">
            <div className="min-w-0 flex-1">
              <div className="text-[13px] text-ink">Conectar también desde fuera de casa</div>
              <div className="mt-0.5 text-[12px] text-ink-4">
                Con datos móviles o en otra wifi, a través de un túnel gratuito de Cloudflare. La dirección cambia cada vez que Acta se reinicia: vuelve a escanear el código.
                {info.tunnel.enabled && info.tunnel.status === 'starting' && <span className="text-ink-3"> · Abriendo el túnel…</span>}
                {info.tunnel.enabled && info.tunnel.status === 'ready' && <span className="text-accent-ink"> · Activo</span>}
                {info.tunnel.enabled && info.tunnel.error && info.tunnel.status !== 'ready' && <span className="text-danger"> · {info.tunnel.error}</span>}
              </div>
            </div>
            <Toggle checked={info.tunnel.enabled} onChange={(v) => void post({ tunnel: v, address: v ? 'internet' : undefined }, v ? 'Abriendo el túnel…' : 'Túnel cerrado')} />
          </div>
        )}

        {info?.enabled && info.error && (
          <div className="px-5 py-3 text-[12.5px] text-danger">No se pudo abrir la conexión: {info.error}</div>
        )}

        {info?.enabled && !info.addresses.length && (
          <div className="px-5 py-3 text-[12.5px] text-ink-3">Este ordenador no está conectado a ninguna red local. Conéctalo a la wifi y vuelve a abrir Ajustes.</div>
        )}

        {info?.enabled && info.running && info.url && (
          <div className="flex flex-wrap items-start gap-6 px-5 py-5">
            <div className="h-[184px] w-[184px] shrink-0 rounded-xl bg-white p-2 [&>svg]:h-full [&>svg]:w-full" dangerouslySetInnerHTML={{ __html: info.qr }} />
            <div className="min-w-[240px] flex-1 space-y-2.5 text-[12.5px] text-ink-3">
              <ol className="list-decimal space-y-1.5 pl-4">
                <li>Abre la cámara del móvil y apunta al código.</li>
                {info.address !== 'internet' && <li>El navegador avisará de que la conexión «no es privada»: es normal, el certificado lo ha creado este ordenador. Pulsa <b className="text-ink-2">Configuración avanzada → Acceder</b> (en iPhone, <b className="text-ink-2">Mostrar detalles → visitar este sitio web</b>).</li>}
                <li>Permite el micrófono y pulsa <b className="text-ink-2">Grabar</b>, o únete a la grabación que ya esté en marcha.</li>
              </ol>
              {info.addresses.length > 1 && (
                <label className="flex items-center gap-2">
                  Red:
                  <select value={info.address} onChange={(e) => void load(e.target.value)} className="h-7 rounded-md border border-hairline-strong bg-raised px-1.5 text-[12px] text-ink outline-none">
                    {info.addresses.map((a) => <option key={a.address} value={a.address}>{a.address === 'internet' ? 'Cualquier red (túnel)' : `${a.address} · ${a.name}`}</option>)}
                  </select>
                </label>
              )}
              {info.qrFile && (
                <div className="text-[12px] text-ink-4">El código actual también se guarda en <code className="text-[11.5px]">{info.qrFile}</code>, para mandártelo por Telegram si reinicias Acta fuera de casa.{info.qrMirror ? <> Copia en <code className="text-[11.5px]">{info.qrMirror}</code>.</> : null}</div>
              )}
              <div className="flex flex-wrap gap-2 pt-1">
                <Button size="sm" variant="outline" onClick={() => void navigator.clipboard.writeText(info.url).then(() => toast('Enlace copiado: contiene el código, compártelo solo con tus dispositivos'))}><Copy size={13} /> Copiar enlace</Button>
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => { if (confirm('Los dispositivos emparejados tendrán que volver a escanear el código. ¿Seguir?')) void post({ rotate: true }, 'Código nuevo: vuelve a escanearlo'); }}><RefreshCw size={13} /> Nuevo código</Button>
              </div>
            </div>
          </div>
        )}

        {info?.enabled && (
          <div className="px-5 py-3.5">
            <div className="mb-2 text-[12px] font-medium text-ink-3">Conectados ahora</div>
            {info.devices.length ? (
              <ul className="space-y-1.5">
                {info.devices.map((d) => (
                  <li key={d.id} className="flex items-center gap-2 text-[13px] text-ink">
                    <Smartphone size={14} className="text-ink-3" />
                    {d.label}
                    <span className="text-[12px] text-ink-4">{d.ip}</span>
                    <span className={cx('ml-auto text-[12px]', d.streaming ? 'text-accent-ink' : 'text-ink-4')}>{d.streaming ? 'enviando audio' : 'en espera'}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="text-[12.5px] text-ink-4">Ninguno. Cuando abras la página en el móvil, aparecerá aquí.</div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
