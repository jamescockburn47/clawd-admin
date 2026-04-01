import { NextRequest, NextResponse } from 'next/server';

const EVO_URL = process.env.EVO_URL!;
const EVO_URL_LAN = process.env.EVO_URL_LAN!;

async function proxyToUrl(
  baseUrl: string,
  path: string[],
  req: NextRequest,
  body: ArrayBuffer | null,
): Promise<Response> {
  const endpoint = path.join('/');
  const url = new URL(`${baseUrl}/${endpoint}`);

  req.nextUrl.searchParams.forEach((value, key) => {
    url.searchParams.set(key, value);
  });

  const method = req.method;
  const hasBody = body !== null && body.byteLength > 0;

  return fetch(url.toString(), {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: hasBody ? body : undefined,
    signal: AbortSignal.timeout(15000),
  });
}

async function handle(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
): Promise<NextResponse> {
  const { path } = await params;

  // Read body once upfront so it can be reused across primary + fallback attempts
  const method = req.method;
  const hasBody = method === 'POST' || method === 'PUT' || method === 'DELETE';
  const body = hasBody ? await req.arrayBuffer() : null;

  // Try primary (Tailscale) URL
  try {
    const res = await proxyToUrl(EVO_URL, path, req, body);
    const resBody = await res.arrayBuffer();
    return new NextResponse(resBody, {
      status: res.status,
      headers: { 'Content-Type': res.headers.get('Content-Type') ?? 'application/json' },
    });
  } catch (primaryErr) {
    console.warn('[api/evo] primary URL failed, trying LAN fallback', {
      url: EVO_URL,
      path: path.join('/'),
      error: String(primaryErr),
    });
  }

  // Fallback to LAN URL
  try {
    const res = await proxyToUrl(EVO_URL_LAN, path, req, body);
    const resBody = await res.arrayBuffer();
    return new NextResponse(resBody, {
      status: res.status,
      headers: { 'Content-Type': res.headers.get('Content-Type') ?? 'application/json' },
    });
  } catch (fallbackErr) {
    console.error('[api/evo] both URLs failed', {
      primary: EVO_URL,
      fallback: EVO_URL_LAN,
      path: path.join('/'),
      error: String(fallbackErr),
    });
    return NextResponse.json(
      { error: 'EVO memory service unreachable', details: String(fallbackErr) },
      { status: 502 },
    );
  }
}

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const DELETE = handle;
