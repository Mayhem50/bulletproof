// ============================================
// Bulletproof — Site Interactions
// ============================================

// Copy install command
function copyInstall() {
  const cmd = 'npx skills add Mayhem50/bulletproof';
  navigator.clipboard.writeText(cmd).then(() => {
    const btn = document.querySelector('.hero-terminal .terminal-copy');
    btn.classList.add('copied');
    setTimeout(() => btn.classList.remove('copied'), 1500);
  });
}

// Make copyInstall available globally
window.copyInstall = copyInstall;

// ============================================
// Scroll Reveal
// ============================================

function initReveal() {
  const elements = document.querySelectorAll(
    '.skill-group, .how-card, .how-detail, .install-card'
  );

  if (!('IntersectionObserver' in window)) {
    elements.forEach(el => el.classList.add('revealed'));
    return;
  }

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add('revealed');
          observer.unobserve(entry.target);
        }
      });
    },
    { threshold: 0.1, rootMargin: '-40px' }
  );

  elements.forEach(el => observer.observe(el));
}

// ============================================
// Nav hide/show on scroll
// ============================================

function initNav() {
  const nav = document.getElementById('nav');
  let lastScroll = 0;

  window.addEventListener('scroll', () => {
    const currentScroll = window.scrollY;

    if (currentScroll > 100 && currentScroll > lastScroll) {
      nav.classList.add('hidden');
    } else {
      nav.classList.remove('hidden');
    }

    lastScroll = currentScroll;
  }, { passive: true });
}

// ============================================
// Staggered reveal for skill groups
// ============================================

function initStagger() {
  const groups = document.querySelectorAll('.skill-group');
  groups.forEach((group, i) => {
    group.style.transitionDelay = `${i * 50}ms`;
  });

  const howCards = document.querySelectorAll('.how-card');
  howCards.forEach((card, i) => {
    card.style.transitionDelay = `${i * 100}ms`;
  });
}

// ============================================
// Init
// ============================================

document.addEventListener('DOMContentLoaded', () => {
  initReveal();
  initNav();
  initStagger();
});
