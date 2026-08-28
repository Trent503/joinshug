/* Shug — joinshug.com. Vanilla JS, no dependencies.
   Handles: lead forms (Formspree), returning-visitor state, sticky CTA bar, stat counters. */
(function () {
  'use strict';

  var ENDPOINT = 'https://formspree.io/f/xbdvybew';  /* do not change — see README */
  var KEY_DONE = 'shug_subscribed';
  var KEY_LEADS = 'shug_leads';

  function ls(fn, fallback) { try { return fn(); } catch (e) { return fallback; } }

  /* ---- Lead forms ------------------------------------------------------ */

  function showDone(form) {
    var done = document.getElementById(form.dataset.done);
    if (!done) return;
    form.hidden = true;
    var aside = form.parentNode.querySelector('[data-form-aside]');
    if (aside) aside.hidden = true;
    done.hidden = false;
  }

  function initForm(form) {
    var err = form.querySelector('[data-err]');

    form.addEventListener('submit', function (e) {
      e.preventDefault();

      /* Honeypot — a bot fills every field it finds. */
      if (form.elements.company && form.elements.company.value) return;

      var name = (form.elements.name.value || '').trim();
      var phone = (form.elements.phone.value || '').trim();
      var trade = form.elements.trade ? (form.elements.trade.value || '').trim() : '';
      var digits = phone.replace(/\D/g, '');

      form.elements.name.setAttribute('aria-invalid', name ? 'false' : 'true');
      form.elements.phone.setAttribute('aria-invalid', digits.length >= 7 ? 'false' : 'true');

      if (!name || digits.length < 7) {
        if (err) {
          err.textContent = !name
            ? 'Add your name so I know who I am calling.'
            : 'That phone number is too short — I need a real one to call you back.';
          err.hidden = false;
        }
        (!name ? form.elements.name : form.elements.phone).focus();
        return;
      }
      if (err) err.hidden = true;

      var payload = {
        name: name,
        phone: phone,
        trade: trade,
        page: document.title,
        path: location.pathname,
        _subject: 'Shug blueprint call — ' + (form.dataset.source || location.pathname)
      };

      ls(function () {
        var list = JSON.parse(localStorage.getItem(KEY_LEADS) || '[]');
        list.push({ name: name, phone: phone, trade: trade, at: new Date().toISOString() });
        localStorage.setItem(KEY_LEADS, JSON.stringify(list));
        localStorage.setItem(KEY_DONE, '1');
      });

      fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(payload)
      })['catch'](function () {});

      showDone(form);
    });
  }

  var forms = [].slice.call(document.querySelectorAll('[data-lead-form]'));
  forms.forEach(initForm);

  /* Returning visitor who already booked — skip straight to the thank-you state. */
  if (ls(function () { return localStorage.getItem(KEY_DONE) === '1'; }, false)) {
    forms.forEach(showDone);
  }

  /* ---- Sticky CTA bar -------------------------------------------------- */

  var sticky = document.getElementById('sticky-cta');
  if (sticky) {
    var apply = document.getElementById('apply');
    var ticking = false;
    var onScroll = function () {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(function () {
        ticking = false;
        var y = window.scrollY || 0;
        var applyVisible = apply && apply.getBoundingClientRect().top < window.innerHeight;
        sticky.classList.toggle('is-off', y < 480 || !!applyVisible);
      });
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll, { passive: true });
    onScroll();
  }

  /* ---- Slide-in nudge (homepage only) ---------------------------------- */

  var nudge = document.getElementById('nudge');
  var story = document.getElementById('story');
  var nudgeSeen = ls(function () { return localStorage.getItem('shug_nudge_done') === '1'; }, false);
  if (nudge && story && !nudgeSeen && 'IntersectionObserver' in window) {
    var nio = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (!en.isIntersecting) return;
        nudge.hidden = false;
        nio.disconnect();
      });
    }, { threshold: 0.15 });
    nio.observe(story);

    var dismiss = function () {
      nudge.hidden = true;
      ls(function () { localStorage.setItem('shug_nudge_done', '1'); });
    };
    var x = document.getElementById('nudge-x');
    if (x) x.addEventListener('click', dismiss);
    var claim = document.getElementById('nudge-claim');
    if (claim) claim.addEventListener('click', dismiss);
  }

  /* ---- Stat counters --------------------------------------------------- */

  var stats = [].slice.call(document.querySelectorAll('[data-count-to]'));
  if (stats.length && 'IntersectionObserver' in window &&
      !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (!en.isIntersecting) return;
        var el = en.target;
        var to = parseFloat(el.dataset.countTo) || 0;
        var pre = el.dataset.prefix || '';
        var suf = el.dataset.suffix || '';
        var start = performance.now();
        var tick = function (now) {
          var p = Math.min(1, (now - start) / 1100);
          var eased = 1 - Math.pow(1 - p, 3);
          el.textContent = pre + Math.round(to * eased).toLocaleString() + suf;
          if (p < 1) requestAnimationFrame(tick);
          else el.textContent = pre + to.toLocaleString() + suf;
        };
        requestAnimationFrame(tick);
        io.unobserve(el);
      });
    }, { threshold: 0.4 });
    stats.forEach(function (el) { io.observe(el); });
  }
  /* ---- products menu -------------------------------------------------
     CSS already opens this on hover and focus-within, so it works with JS
     off. This adds click-toggle for touch, Escape to close, and keeps
     aria-expanded truthful for screen readers. */
  var menuBtn = document.querySelector('.navmenu-btn');
  if (menuBtn) {
    var menu = menuBtn.parentNode;
    var setOpen = function (open) {
      menuBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    };
    menuBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      menu.classList.remove('is-dismissed');
      setOpen(menuBtn.getAttribute('aria-expanded') !== 'true');
    });
    // Any pointer re-entry clears an Escape dismissal.
    menu.addEventListener('mouseenter', function () {
      menu.classList.remove('is-dismissed');
    });
    document.addEventListener('click', function (e) {
      if (!menu.contains(e.target)) setOpen(false);
    });
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      if (!menu.contains(document.activeElement) &&
          menuBtn.getAttribute('aria-expanded') !== 'true') return;
      menu.classList.add('is-dismissed');
      setOpen(false);
      menuBtn.focus();
    });
    menu.addEventListener('focusout', function () {
      setTimeout(function () {
        if (!menu.contains(document.activeElement)) {
          setOpen(false);
          menu.classList.remove('is-dismissed');
        }
      }, 0);
    });
  }

})();
