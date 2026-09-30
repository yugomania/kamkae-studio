// Firebase Configuration & Native Adapter
window.KamkaeFirebase = {
  isConfigured: false,
  user: {
    uid: 'local-creator',
    email: 'ugoodagu@gmail.com',
    displayName: 'ugochukwuodagu'
  },

  async init() {
    try {
      const res = await fetch('/api/firebase-config');
      const data = await res.json();

      if (data.enabled && data.config && data.config.apiKey) {
        console.log('[Firebase] Initializing client SDK with project:', data.config.projectId);
        this.isConfigured = true;
        // Load Firebase SDK dynamically if needed
        this._loadFirebaseSDK(data.config);
      } else {
        console.log('[Firebase] Running in local studio state (Firebase credentials pending in .env)');
      }
    } catch (e) {
      console.warn('[Firebase] Config fetch warning:', e);
    }
  },

  _loadFirebaseSDK(config) {
    // When Firebase credentials are supplied, dynamically mount Firebase compat SDK
    const scriptApp = document.createElement('script');
    scriptApp.src = 'https://www.gstatic.com/firebasejs/10.8.0/firebase-app-compat.js';
    scriptApp.onload = () => {
      const scriptAuth = document.createElement('script');
      scriptAuth.src = 'https://www.gstatic.com/firebasejs/10.8.0/firebase-auth-compat.js';
      const scriptFirestore = document.createElement('script');
      scriptFirestore.src = 'https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore-compat.js';

      scriptAuth.onload = () => {
        if (window.firebase) {
          try {
            if (!firebase.apps.length) {
              firebase.initializeApp(config);
            }
            firebase.auth().onAuthStateChanged((user) => {
              if (user) {
                this.user = user;
                const nameEl = document.getElementById('user-display-name');
                if (nameEl) nameEl.textContent = user.displayName || user.email.split('@')[0];
              }
            });
          } catch (err) {
            console.warn('[Firebase] SDK init error:', err);
          }
        }
      };
      document.head.appendChild(scriptAuth);
      document.head.appendChild(scriptFirestore);
    };
    document.head.appendChild(scriptApp);
  },

  async signIn(email, password) {
    if (this.isConfigured && window.firebase) {
      return firebase.auth().signInWithEmailAndPassword(email, password);
    } else {
      // Local session sign in
      this.user = {
        uid: 'user_' + Date.now(),
        email: email,
        displayName: email.split('@')[0]
      };
      return Promise.resolve(this.user);
    }
  },

  async signUp(email, password) {
    if (this.isConfigured && window.firebase) {
      return firebase.auth().createUserWithEmailAndPassword(email, password);
    } else {
      this.user = {
        uid: 'user_' + Date.now(),
        email: email,
        displayName: email.split('@')[0]
      };
      return Promise.resolve(this.user);
    }
  }
};

window.KamkaeFirebase.init();
