export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === "OPTIONS") {
      return corsResponse(null, env, 204);
    }

    if (url.pathname === "/reviews") {
      try {
        const limit = clampInt(url.searchParams.get("limit") ?? "10", 1, 50);
        const accountId = url.searchParams.get("accountId") || env.GBP_ACCOUNT_ID;
        const locationId = url.searchParams.get("locationId") || env.GBP_LOCATION_ID;
        const reviews = await fetchLatestReviews(env, limit, accountId, locationId);

        return corsResponse(
          JSON.stringify({ reviews }),
          env,
          200,
          { "Content-Type": "application/json; charset=utf-8" }
        );
      } catch (err) {
        return corsResponse(
          JSON.stringify({ error: err.message }),
          env,
          500,
          { "Content-Type": "application/json; charset=utf-8" }
        );
      }
    }

    return corsResponse("Not found", env, 404, { "Content-Type": "text/plain; charset=utf-8" });
  },
};

function corsResponse(body, env, status = 200, headers = {}) {
  const allowed = env.ALLOWED_ORIGIN || "*";
  return new Response(body, {
    status,
    headers: {
      ...headers,
      "Access-Control-Allow-Origin": allowed,
      "Access-Control-Allow-Methods": "GET,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type,Authorization",
      "Access-Control-Max-Age": "86400",
    },
  });
}

function clampInt(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

async function fetchLatestReviews(env, limit, accountId, locationId) {
  const accessToken = await getAccessToken(env);

  if (!accountId || !locationId || accountId.includes("YOUR_") || locationId.includes("YOUR_")) {
    throw new Error("Missing/placeholder accountId or locationId. Provide ?accountId=...&locationId=... or set Worker vars.");
  }

  const base = `https://mybusiness.googleapis.com/v4/accounts/${accountId}/locations/${locationId}/reviews`;

  let pageToken = null;
  const all = [];

  while (all.length < limit) {
    const u = new URL(base);
    u.searchParams.set("pageSize", String(Math.min(50, limit - all.length)));
    if (pageToken) u.searchParams.set("pageToken", pageToken);

    const resp = await fetch(u.toString(), {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`GBP reviews list failed: ${resp.status} ${text}`);
    }

    const json = await resp.json();
    const reviews = json.reviews || [];
    all.push(...reviews);

    pageToken = json.nextPageToken;
    if (!pageToken || reviews.length === 0) break;
  }

  // Normalize to the fields your UI expects
  const normalized = all.slice(0, limit).map((r) => {
    const rating = starEnumToNumber(r.starRating);
    const createTime = r.createTime ? new Date(r.createTime) : null;

    return {
      reviewId: r.reviewId,
      author_name: r.reviewer?.displayName || "Anonymous",
      profile_photo_url: r.reviewer?.profilePhotoUrl || "",
      rating,
      time: createTime ? Math.floor(createTime.getTime() / 1000) : 0,
      text: r.comment || "",
      createTime: r.createTime || null,
      updateTime: r.updateTime || null,
    };
  });

  // Make sure newest-first
  normalized.sort((a, b) => (b.time || 0) - (a.time || 0));
  return normalized;
}

function starEnumToNumber(starRating) {
  const map = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };
  return map[starRating] || 0;
}

async function getAccessToken(env) {
  // Store these as secrets in Cloudflare (never in GitHub / HTML)
  const clientId = env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = env.GOOGLE_OAUTH_CLIENT_SECRET;
  const refreshToken = env.GOOGLE_OAUTH_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error("Missing OAuth secrets in Worker env.");
  }

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });

  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`OAuth token refresh failed: ${resp.status} ${text}`);
  }

  const json = await resp.json();
  if (!json.access_token) throw new Error("OAuth token refresh returned no access_token.");

  return json.access_token;
}
