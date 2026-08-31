document.querySelectorAll('[data-view]').forEach((link) => {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        const target = link.getAttribute('data-view');
        document.querySelectorAll('[data-view]').forEach((a) => a.classList.remove('active'));
        link.classList.add('active');
        document.querySelectorAll('[data-view-panel]').forEach((p) => {
          p.classList.toggle('active', p.getAttribute('data-view-panel') === target);
        });
      });
    });
