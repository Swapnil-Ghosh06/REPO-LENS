/**
 * Cloudflare Worker for RepoLens Proxy
 * Securely holds API keys and routes requests to LLM providers.
 */

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export default {
  async fetch(request, env, ctx) {
    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405, headers: corsHeaders });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path === "/gemini-embed") {
        return await handleGeminiEmbed(request, env);
      } else if (path === "/cohere-embed") {
        return await handleCohereEmbed(request, env);
      } else if (path === "/groq-chat-1") {
        return await handleGroqChat(request, env.GROQ_API_KEY);
      } else if (path === "/groq-chat-2") {
        return await handleGroqChat(request, env.GROQ_API_KEY_2);
      } else if (path === "/gemini-chat") {
        return await handleGeminiChat(request, env);
      } else {
        return new Response("Not Found", { status: 404, headers: corsHeaders });
      }
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }
  }
};

async function handleGeminiEmbed(request, env) {
  if (!env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY not configured on proxy");
  const body = await request.json();
  const targetUrl = `https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:batchEmbedContents?key=${env.GEMINI_API_KEY}`;
  
  const res = await fetch(targetUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  
  return createCorsResponse(res);
}

async function handleCohereEmbed(request, env) {
  if (!env.COHERE_API_KEY) throw new Error("COHERE_API_KEY not configured on proxy");
  const body = await request.json();
  
  const res = await fetch("https://api.cohere.com/v2/embed", {
    method: "POST",
    headers: { 
      "Authorization": `Bearer ${env.COHERE_API_KEY}`,
      "Content-Type": "application/json" 
    },
    body: JSON.stringify(body)
  });
  
  return createCorsResponse(res);
}

async function handleGroqChat(request, apiKey) {
  if (!apiKey) throw new Error("Groq API key not configured on proxy");
  const body = await request.json();
  
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { 
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json" 
    },
    body: JSON.stringify(body)
  });
  
  return createCorsResponse(res);
}

async function handleGeminiChat(request, env) {
  if (!env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY not configured on proxy");
  const body = await request.json();
  const targetUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:streamGenerateContent?alt=sse&key=${env.GEMINI_API_KEY}`;
  
  const res = await fetch(targetUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  
  return createCorsResponse(res);
}

/**
 * Creates a response that clones the provider response and injects CORS headers.
 */
function createCorsResponse(res) {
  const newHeaders = new Headers(res.headers);
  for (const [k, v] of Object.entries(corsHeaders)) {
    newHeaders.set(k, v);
  }
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers: newHeaders
  });
}
