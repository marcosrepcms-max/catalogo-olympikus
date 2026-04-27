export default {
  async fetch(request, env) {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, PATCH, OPTIONS",
      "Content-Type": "application/json; charset=utf-8"
    };

    const githubHeaders = {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "repasse-worker"
    };

    const GITHUB_PEDIDOS  = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/data/pedidos.json`;
    const GITHUB_DESM     = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/data/desmembramentos.json`;
    const GITHUB_OCULTOS  = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/data/ocultos.json`;
    const GITHUB_DISPO    = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/data/dispo.json`;
    const GITHUB_PRODUTOS = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/data/produtos.json`;

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // ── HELPERS ──────────────────────────────────────────────────────────────

    async function getFile(url) {
      const res = await fetch(url, { headers: githubHeaders });
      if (res.status === 404) return { content: null, sha: null };
      if (!res.ok) throw new Error(`GET GitHub falhou (${res.status}): ${await res.text()}`);
      const data = await res.json();
      return { content: JSON.parse(atob(data.content)), sha: data.sha };
    }

    async function saveFile(url, content, sha, message) {
      const body = {
        message,
        content: btoa(unescape(encodeURIComponent(JSON.stringify(content, null, 2)))),
        branch: env.GITHUB_BRANCH
      };
      if (sha) body.sha = sha;
      const res = await fetch(url, {
        method: "PUT",
        headers: { ...githubHeaders, "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      if (!res.ok) throw new Error(`PUT GitHub falhou (${res.status}): ${await res.text()}`);
      return res.json();
    }

    // Atalhos para pedidos
    async function getPedidos() { return getFile(GITHUB_PEDIDOS); }
    async function savePedidos(list, sha, msg = "update pedidos") {
      return saveFile(GITHUB_PEDIDOS, list, sha, msg);
    }

    // ── ROTEAMENTO ───────────────────────────────────────────────────────────

    try {

      // GET — retorna pedidos (array, mantém retrocompatibilidade)
      if (request.method === "GET") {
        const { content } = await getPedidos();
        return new Response(JSON.stringify(content || []), { status: 200, headers: corsHeaders });
      }

      // POST — novo pedido
      if (request.method === "POST") {
        const body = await request.json();
        const { content, sha } = await getPedidos();
        const list = content || [];
        list.push({ ...body, createdAt: body.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString() });
        await savePedidos(list, sha, "novo pedido");
        return new Response(JSON.stringify({ success: true }), { status: 200, headers: corsHeaders });
      }

      // PUT — atualiza pedido existente
      if (request.method === "PUT") {
        const body = await request.json();
        if (!body?.id) return new Response(JSON.stringify({ success: false, error: "ID não informado." }), { status: 400, headers: corsHeaders });
        const { content, sha } = await getPedidos();
        const list = content || [];
        const idx = list.findIndex(p => p.id === body.id);
        if (idx === -1) return new Response(JSON.stringify({ success: false, error: "Pedido não encontrado." }), { status: 404, headers: corsHeaders });
        list[idx] = { ...list[idx], ...body, updatedAt: new Date().toISOString() };
        await savePedidos(list, sha, "update pedido");
        return new Response(JSON.stringify({ success: true }), { status: 200, headers: corsHeaders });
      }

      // DELETE — exclui pedido e limpa desmembramentos órfãos
      if (request.method === "DELETE") {
        const body = await request.json();
        if (!body?.id) return new Response(JSON.stringify({ success: false, error: "ID não informado." }), { status: 400, headers: corsHeaders });

        // Remove o pedido
        const { content, sha } = await getPedidos();
        const list = (content || []).filter(p => p.id !== body.id);
        if (list.length === (content||[]).length) return new Response(JSON.stringify({ success: false, error: "Pedido não encontrado." }), { status: 404, headers: corsHeaders });
        await savePedidos(list, sha, "delete pedido");

        // Limpa entradas do desmembramentos que referenciam este pedido
        // Chave do desmembramento: "codigo|cor|prevFat" → { "orderId||gci||cor": status }
        try {
          const { content: desm, sha: desmSha } = await getFile(GITHUB_DESM);
          if (desm && typeof desm === 'object') {
            const desmLimpo = {};
            for (const [chave, lojas] of Object.entries(desm)) {
              const lojasFiltradas = {};
              for (const [lineKey, status] of Object.entries(lojas || {})) {
                // lineKey formato: "orderId||gci||cor" — remove se contém o id excluído
                if (!lineKey.startsWith(body.id + '||')) {
                  lojasFiltradas[lineKey] = status;
                }
              }
              // Só mantém a chave se ainda tem lojas
              if (Object.keys(lojasFiltradas).length > 0) {
                desmLimpo[chave] = lojasFiltradas;
              }
            }
            await saveFile(GITHUB_DESM, desmLimpo, desmSha, "limpar desmembramentos do pedido " + body.id);
          }
        } catch(_) { /* não bloqueia o delete se desmembramentos falhar */ }

        return new Response(JSON.stringify({ success: true, deletedId: body.id }), { status: 200, headers: corsHeaders });
      }

      // PATCH — salva/lê desmembramentos (arquivo separado)
      if (request.method === "PATCH") {
        const body = await request.json();

        // PATCH sem body ou com action:"get" → retorna desmembramentos
        if (!body || body.action === "get") {
          const { content } = await getFile(GITHUB_DESM);
          return new Response(JSON.stringify(content || {}), { status: 200, headers: corsHeaders });
        }

        // PATCH com action:"save" e data:{} → salva desmembramentos
        if (body.action === "save" && body.data) {
          const { content, sha } = await getFile(GITHUB_DESM);
          const merged = { ...(content || {}), ...body.data };
          await saveFile(GITHUB_DESM, merged, sha, "update desmembramentos");
          return new Response(JSON.stringify({ success: true }), { status: 200, headers: corsHeaders });
        }

        // PATCH com action:"getDispo" → retorna dispo.json
        if (body.action === "getDispo") {
          const { content } = await getFile(GITHUB_DISPO);
          return new Response(JSON.stringify(Array.isArray(content) ? content : []), { status: 200, headers: corsHeaders });
        }

        // PATCH com action:"saveDispo" e data:[] → salva dispo.json completo
        if (body.action === "saveDispo" && body.data !== undefined) {
          const { sha } = await getFile(GITHUB_DISPO);
          await saveFile(GITHUB_DISPO, Array.isArray(body.data) ? body.data : [], sha, "update dispo");
          return new Response(JSON.stringify({ success: true }), { status: 200, headers: corsHeaders });
        }

        // PATCH com action:"getProdutos" → retorna produtos.json
        if (body.action === "getProdutos") {
          const { content } = await getFile(GITHUB_PRODUTOS);
          return new Response(JSON.stringify(Array.isArray(content) ? content : []), { status: 200, headers: corsHeaders });
        }

        // PATCH com action:"saveProdutos" e data:[] → salva produtos.json completo
        if (body.action === "saveProdutos" && body.data !== undefined) {
          const { sha } = await getFile(GITHUB_PRODUTOS);
          await saveFile(GITHUB_PRODUTOS, Array.isArray(body.data) ? body.data : [], sha, "update produtos");
          return new Response(JSON.stringify({ success: true }), { status: 200, headers: corsHeaders });
        }

        // PATCH com action:"getOcultos" → retorna lista de ocultos
        if (body.action === "getOcultos") {
          const { content } = await getFile(GITHUB_OCULTOS);
          return new Response(JSON.stringify(Array.isArray(content) ? content : []), { status: 200, headers: corsHeaders });
        }

        // PATCH com action:"saveOcultos" e data:[] → salva lista de ocultos
        if (body.action === "saveOcultos" && body.data !== undefined) {
          const { sha } = await getFile(GITHUB_OCULTOS);
          await saveFile(GITHUB_OCULTOS, Array.isArray(body.data) ? body.data : [], sha, "update ocultos");
          return new Response(JSON.stringify({ success: true }), { status: 200, headers: corsHeaders });
        }

        return new Response(JSON.stringify({ success: false, error: "PATCH: action inválida." }), { status: 400, headers: corsHeaders });
      }

      return new Response(JSON.stringify({ error: "Not found" }), { status: 404, headers: corsHeaders });

    } catch (error) {
      return new Response(JSON.stringify({ success: false, error: error.message || "Erro interno" }), { status: 500, headers: corsHeaders });
    }
  }
};