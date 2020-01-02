(function() {
  class InsteonExtension extends window.Extension {
    constructor() {
      super('insteon-adapter');
      this.addMenuEntry('INSTEON');

      this.content = '';
      fetch(`/extensions/${this.id}/views/content.html`)
        .then((res) => res.text())
        .then((text) => {
          this.content = text;
        })
        .catch((e) => console.error('Failed to fetch content:', e));
    }

    show() {
      this.view.innerHTML = this.content;

      const scanButton = document.getElementById('button-scan');
      scanButton.addEventListener('click', async () => {
        window.API.postJson(`/extensions/${this.id}/api/scan`);
      });
    }
  }

  new InsteonExtension();
})();
