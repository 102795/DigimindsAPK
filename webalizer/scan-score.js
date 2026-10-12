(() => {
  const result = document.getElementById('result');
  if (!result) return;

  const findScore = () => {
    const dataScore = result.querySelector('[data-score]')?.getAttribute('data-score');
    if (dataScore !== null && dataScore !== undefined && Number.isFinite(Number(dataScore))) {
      return Math.max(0, Math.min(100, Number(dataScore)));
    }

    const copy = result.cloneNode(true);
    copy.querySelector('.real-score-card')?.remove();
    const text = copy.textContent.replace(/\s+/g, ' ').trim();
    const outOf100 = text.match(/(\d{1,3}(?:[.,]\d+)?)\s*\/\s*100\b/i);
    if (outOf100) return Math.max(0, Math.min(100, Number(outOf100[1].replace(',', '.'))));

    const percentage = text.match(/(?:score|totaalscore|websitecheck)[^\d]{0,24}(\d{1,3}(?:[.,]\d+)?)\s*%/i);
    if (percentage) return Math.max(0, Math.min(100, Number(percentage[1].replace(',', '.'))));

    const labelled = text.match(/(?:score|totaalscore)\s*:?\s*(\d{1,3}(?:[.,]\d+)?)(?![\d.,])/i);
    if (labelled) {
      const value = Number(labelled[1].replace(',', '.'));
      return Math.max(0, Math.min(100, value <= 10 && labelled[1].includes('.') ? value * 10 : value));
    }
    return null;
  };

  const render = () => {
    const score = findScore();
    const hasResults = result.textContent.trim().length > 0;
    let card = result.querySelector('.real-score-card');
    if (!hasResults) {
      card?.remove();
      return;
    }
    const isNew = !card;
    if (isNew) {
      card = document.createElement('section');
      card.className = 'real-score-card';
      card.setAttribute('aria-label', 'Totaalscore van de websitecheck');
      card.innerHTML = '<div class="real-score-heading"><span><strong class="real-score-title"></strong><small class="real-score-caption"></small></span><span class="real-score-value"><b></b><small>/ 100</small></span></div><div class="real-score-track" role="progressbar" aria-valuemin="0" aria-valuemax="100"><span></span></div>';
      result.prepend(card);
    }
    const hasScore = score !== null;
    const progress = hasScore ? Math.round(score) : 100;
    card.querySelector('.real-score-title').textContent = hasScore ? 'Jouw website-score' : 'Scan afgerond';
    card.querySelector('.real-score-caption').textContent = hasScore ? 'Resultaat van deze scan' : 'Je resultaten zijn klaar';
    card.querySelector('.real-score-value').hidden = !hasScore;
    card.querySelector('.real-score-track').setAttribute('aria-label', hasScore ? 'Website-score' : 'Scanvoortgang');
    card.querySelector('.real-score-track').setAttribute('aria-valuenow', progress);
    card.querySelector('.real-score-track span').style.width = `${progress}%`;
  };

  new MutationObserver(render).observe(result, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['data-score'] });
  render();
})();
(() => {
  const result = document.getElementById('result');
  if (!result) return;

  const getScore = () => {
    const copy = result.cloneNode(true);
    copy.querySelector('#live-score-progress')?.remove();
    const text = copy.textContent.replace(/\s+/g, ' ');
    const match = text.match(/\b(\d{1,3})\s*\/\s*100\b/)
      || text.match(/\b(\d{1,2}(?:[.,]\d+)?)\s*\/\s*10\b/)
      || text.match(/(?:score|rating|cijfer)\s*:?\s*(\d{1,3})\s*%?/i);
    if (!match) return null;
    const score = Number(match[1].replace(',', '.'));
    const outOfTen = /\/\s*10\b/.test(match[0]);
    return Math.max(0, Math.min(100, Math.round(outOfTen ? score * 10 : score)));
  };

  const updateProgress = () => {
    const score = getScore();
    let card = result.querySelector('#live-score-progress');

    if (score === null) {
      card?.remove();
      return;
    }

    if (!card) {
      card = document.createElement('section');
      card.id = 'live-score-progress';
      card.className = 'live-score-progress';
      card.setAttribute('aria-label', 'Website-score');
      card.innerHTML = '<div class="live-score-progress__heading"><strong>Jouw website-score</strong><span><b></b> / 100</span></div><div class="live-score-progress__track" role="progressbar" aria-label="Website-score" aria-valuemin="0" aria-valuemax="100"><span></span></div>';
      card.querySelector('.live-score-progress__track span').style.width = '0%';
      result.prepend(card);
    }

    if (card.dataset.score === String(score)) return;
    card.dataset.score = String(score);
    card.querySelector('.live-score-progress__heading b').textContent = score;
    card.querySelector('.live-score-progress__track').setAttribute('aria-valuenow', score);
    const fill = card.querySelector('.live-score-progress__track span');
    if (isNew) {
      requestAnimationFrame(() => {
        if (card.isConnected && card.dataset.score === String(score)) fill.style.width = `${score}%`;
      });
    } else {
      fill.style.width = `${score}%`;
    }
  };

  new MutationObserver(updateProgress).observe(result, {
    childList: true,
    subtree: true,
    characterData: true
  });
  updateProgress();
})();
