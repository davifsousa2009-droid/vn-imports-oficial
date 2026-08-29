// Avaliações públicas (reviews) — extraído de VN_IMPORTS.html (Estágio 2).
// Depende de escHtml() (ainda inline em VN_IMPORTS.html nesta etapa —
// migra para js/vn-core.js na etapa 3 desta divisão) e de API_URL/observeFI
// (idem, inline por enquanto). Chamado de fora só pelo bootstrap
// (carregarReviewsPublic no DOMContentLoaded) e pelo atributo onsubmit do
// formulário de avaliação no HTML (submitReviewPublic).

function starsToText(n){
  const k = Math.max(1, Math.min(5, Number(n)||0));
  return '<i class="fa-solid fa-star ui-ico" aria-hidden="true"></i>'.repeat(k);
}

function carregarReviewsPublic(){
  return (async () => {
    try{
      const r = await fetch(API_URL + '/reviews/public');
      if(!r.ok) throw new Error('reviews http ' + r.status);
      const list = await r.json();
      renderReviewsPublic(list);
    } catch(e){
      // mantém layout sem travar
      const grid = document.getElementById('revGrid');
      if(grid) grid.innerHTML = '<div style="grid-column:1/-1;color:var(--muted);padding:28px 0;text-align:center">Não foi possível carregar avaliações.</div>';
    }
  })();
}

function renderReviewsPublic(list){
  const safe = Array.isArray(list) ? list : [];

  // Summary
  const total = safe.length;
  if(total === 0){
    document.getElementById('revAvgNum').textContent = '—';
    document.getElementById('revAvgLabel').textContent = '0 avaliações';
    [1,2,3,4,5].forEach(i=>{
      const bar = document.getElementById('revBar'+i);
      const txt = document.getElementById('revBar'+i+'Txt');
      if(bar){ bar.style.width = '0%'; bar.dataset.w = '0%'; }
      if(txt) txt.textContent = '0%';
    });
  } else {
    const avg = safe.reduce((s,x)=>s + (Number(x.estrelas)||0),0) / total;
    document.getElementById('revAvgNum').textContent = (Math.round(avg*10)/10).toString();
    document.getElementById('revAvgLabel').textContent = `${total} avaliação${total===1?'':'es'}`;

    // Distribuição por estrela
    const counts = {1:0,2:0,3:0,4:0,5:0};
    safe.forEach(r=>{ counts[Number(r.estrelas)||0] = (counts[Number(r.estrelas)||0]||0) + 1; });
    [1,2,3,4,5].forEach(i=>{
      const pct = Math.round((counts[i] / total) * 100);
      const bar = document.getElementById('revBar'+i);
      const txt = document.getElementById('revBar'+i+'Txt');
      if(bar){ bar.style.width = pct+'%'; bar.dataset.w = pct+'%'; }
      if(txt) txt.textContent = pct+'%';
    });
  }

  // Grid luxuoso
  const grid = document.getElementById('revGrid');
  if(!grid) return;

  grid.innerHTML = safe.map(r=>{
    const stars = '<i class="fa-solid fa-star ui-ico" aria-hidden="true"></i>'.repeat(Math.max(1, Math.min(5, Number(r.estrelas)||0)));
    const texto = escHtml(r.comentario);
    const nome = escHtml(r.nome);
    const dt = r.data ? new Date(r.data).toLocaleDateString('pt-BR') : '';
    return `
      <div class="rev-card fi">
        <div class="rc-stars">${stars}</div>
        <div class="rc-text">"${texto}"</div>
        <div class="rc-author">
          <div class="rc-av">${nome.trim().slice(0,1).toUpperCase()}</div>
          <div>
            <div class="rc-name">${nome}</div>
            <div class="rc-date">${dt}</div>
            <div class="rc-badge"><i class="fa-solid fa-check ui-ico ui-ico-gap" aria-hidden="true"></i>Depoimento</div>
          </div>
        </div>
      </div>`;
  }).join('');

  observeFI();
}

async function submitReviewPublic(e){
  e.preventDefault();
  const msgEl = document.getElementById('revFormMsg');
  const form = document.getElementById('revPublicForm');

  const nome = document.getElementById('revNome').value.trim();
  const estrelas = Number(document.getElementById('revEstrelas').value);
  const comentario = document.getElementById('revComentario').value.trim();

  if(!nome){ if(msgEl){ msgEl.textContent='Informe seu nome.'; msgEl.style.display='block'; msgEl.style.color='var(--red)'; } return; }
  if(!Number.isFinite(estrelas) || estrelas < 1 || estrelas > 5){ if(msgEl){ msgEl.textContent='Escolha estrelas entre 1 e 5.'; msgEl.style.display='block'; msgEl.style.color='var(--red)'; } return; }
  if(!comentario){ if(msgEl){ msgEl.textContent='Escreva um comentário.'; msgEl.style.display='block'; msgEl.style.color='var(--red)'; } return; }

  try{
    const r = await fetch(API_URL + '/reviews', {
      method:'POST',
      headers:{ 'Content-Type':'application/json' },
      body: JSON.stringify({ nome, estrelas, comentario })
    });
    const d = await r.json().catch(()=>({}));
    if(r.ok){
      if(msgEl){
        msgEl.textContent='Recebido! Seu depoimento ficará disponível após aprovação.';
        msgEl.style.display='block';
        msgEl.style.color='var(--green)';
      }
      form.reset();
      // atualiza lista (pode não refletir imediatamente por causa de aprovado=false)
  carregarReviewsPublic().catch((e)=>console.error(e));
    } else {
      if(msgEl){
        msgEl.textContent = d.erro || 'Erro ao enviar avaliação.';
        msgEl.style.display='block';
        msgEl.style.color='var(--red)';
      }
    }
  } catch{
    if(msgEl){
      msgEl.textContent='Servidor offline. Tente novamente mais tarde.';
      msgEl.style.display='block';
      msgEl.style.color='var(--red)';
    }
  }
}
