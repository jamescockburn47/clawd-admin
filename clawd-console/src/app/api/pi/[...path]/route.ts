import { NextRequest, NextResponse } from 'next/server';

const PI_URL = process.env.PI_URL ?? '';
const PI_URL_LAN = process.env.PI_URL_LAN ?? '';
const DASHBOARD_TOKEN = process.env.DASHBOARD_TOKEN ?? '';

async function proxyRequest(
  baseUrl: string,
  path: string[],
  req: NextRequest,
): Promise<Response> {
  const url = `${baseUrl}/api/${path.join('/')}`;
  const headers: HeadersInit = {
    'Authorization': `Bearer ${DASHBOARD_TOKEN}`,
    'Content-Type': 'application/json',
  };

  const method = req.method;
  const hasBody = method === 'POST' || method === 'PUT' || method === 'DELETE';

  return fetch(url, {
    method,
    headers,
    body: hasBody ? req.body : undefined,
    signal: AbortSignal.timeout(15000),
    // @ts-expect-error — Node 18+ fetch requires this to stream the body
    duplex: hasBody ? 'half' : undefined,
  });
}

async function handler(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
): Promise<NextResponse> {
  const { path } = await params;

  let response: Response | null = null;
  let primaryError: string | null = null;

  // Attempt primary URL
  if (PI_URL) {
    try {
      response = await proxyRequest(PI_URL, path, req);
    } catch (err) {
      primaryError = err instanceof Error ? err.message : String(err);
    }
  } else {
    primaryError = 'PI_URL not configured';
  }

  // Fallback to LAN URL if primary failed
  if (!response && PI_URL_LAN) {
    try {
      response = await proxyRequest(PI_URL_LAN, path, req.clone() as NextRequest);
    } catch (err) {
      const lanError = err instanceof Error ? err.message : String(err);
      return NextResponse.json(
        {
          error: 'Both Pi endpoints unreachable',
          primary: primaryError,
          lan: lanError,
        },
        { status: 502 },
      );
    }
  }

  if (!response) {
    return NextResponse.json(
      { error: 'Pi endpoints not configured or unreachable', primary: primaryError },
      { status: 502 },
    );
  }

  const body = await response.arrayBuffer();
  const contentType = response.headers.get('content-type') ?? 'application/json';

  return new NextResponse(body, {
    status: response.status,
    headers: { 'Content-Type': contentType },
  });
}

export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const DELETE = handler;
