(() => {
  const results = document.getElementById('result');
  if (!results) return;

  const readScore = () => {
    const text = results.textContent.replace(/\s+/g, ' ');
    let match = text.match(/\b(\d{1,3})\s*\/\s*100\b/);
    if (match) return Math.max(0, Math.min(100, Number(match[1])));

    match = text.match(/\b(\d{1,2}(?:[.,]\d+)?)\s*\/\s*10\b/);
    if (match) return Math.max(0, Math.min(100, Math.round(Number(match[1].replace(',', '.')) * 10)));

    match = text.match(/(?:score|rating|cijfer)\s*:?\s*(\d{1,3})\s*%?/i);
    return match ? Math.max(0, Math.min(100, Number(match[1]))) : null;
  };

  const showScore = (score) => {
    const bar = document.createElement('section');
    bar.className = 'site-score-bar';
    bar.setAttribute('aria-label', `Website-score: ${score} van de 100`);
    bar.innerHTML = `<div class="site-score-bar__label"><strong>Website-score</strong><span><b>${score}</b> / 100</span></div><div class="site-score-bar__track" role="progressbar" aria-label="Website-score" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${score}"><span></span></div>`;
    results.prepend(bar);
    requestAnimationFrame(() => {
      bar.querySelector('.site-score-bar__track span').style.width = `${score}%`;
    });
  };

  const checkOnce = () => {
    const score = readScore();
    if (score === null) return false;
    showScore(score);
    return true;
  };

  if (checkOnce()) return;
  const observer = new MutationObserver(() => {
    if (checkOnce()) observer.disconnect();
  });
  observer.observe(results, { childList: true, subtree: true, characterData: true });
})();
