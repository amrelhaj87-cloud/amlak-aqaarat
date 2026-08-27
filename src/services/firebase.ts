import { initializeApp, getApps, FirebaseApp } from 'firebase/app';
import { 
  getAuth, 
  GoogleAuthProvider, 
  signInWithPopup, 
  signInWithEmailAndPassword, 
  createUserWithEmailAndPassword, 
  signOut, 
  onAuthStateChanged, 
  User,
  updateProfile,
  Auth
} from 'firebase/auth';
import { 
  getFirestore, 
  doc, 
  setDoc, 
  getDoc, 
  updateDoc, 
  onSnapshot, 
  collection,
  addDoc,
  Firestore,
  serverTimestamp
} from 'firebase/firestore';
import { UserProfile, FirebaseConfigOptions } from '../types/auth';
import { Room } from '../types/room';
import { GameState } from '../types/game';



// Real Firebase configuration provided by the user
const DEFAULT_FIREBASE_CONFIG: FirebaseConfigOptions = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: "monopoly-arabic-db839.firebaseapp.com",
  projectId: "monopoly-arabic-db839",
  storageBucket: "monopoly-arabic-db839.firebasestorage.app",
  messagingSenderId: "277273972666",
  appId: "1:277273972666:web:3aaa8f9e15c382cf4a5783",
  measurementId: "G-4E0BD5MFD6"
};

class FirebaseService {
  private app: FirebaseApp | null = null;
  private auth: Auth | null = null;
  private db: Firestore | null = null;
  private isConfigured: boolean = false;
  private broadcastChannel: BroadcastChannel | null = null;

  constructor() {
    this.initBroadcast();
    this.init();
  }

  private initBroadcast() {
    if (typeof window !== 'undefined' && 'BroadcastChannel' in window) {
      this.broadcastChannel = new BroadcastChannel('monopoly_arabic_channel');
    }
  }

  public getBroadcastChannel(): BroadcastChannel | null {
    return this.broadcastChannel;
  }

  public init(customConfig?: FirebaseConfigOptions) {
    try {
      // Force use of the embedded config since it's hardcoded and real
      const config = customConfig || DEFAULT_FIREBASE_CONFIG;
      
      if (config.apiKey && config.projectId) {
        if (!getApps().length) {
          this.app = initializeApp(config);
        } else {
          this.app = getApps()[0];
        }
        this.auth = getAuth(this.app);
        this.db = getFirestore(this.app);
        this.isConfigured = true;
      } else {
        this.isConfigured = false;
      }
    } catch (err) {
      console.warn('Firebase initialization error:', err);
      this.isConfigured = false;
    }
  }

  public saveConfig(config: FirebaseConfigOptions) {
    localStorage.setItem('monopoly_arabic_firebase_config', JSON.stringify(config));
    this.init(config);
  }

  public getSavedConfig(): FirebaseConfigOptions | null {
    const saved = localStorage.getItem('monopoly_arabic_firebase_config');
    return saved ? JSON.parse(saved) : null;
  }

  public hasValidCloudConfig(): boolean {
    return this.isConfigured && this.auth !== null && this.db !== null;
  }

  public getAuthInstance(): Auth | null {
    return this.auth;
  }

  public getDbInstance(): Firestore | null {
    return this.db;
  }

  // --- Auth Handlers ---
  public async loginWithGoogle(): Promise<User | null> {
    if (!this.hasValidCloudConfig() || !this.auth) {
      throw new Error('لم يتم ضبط مفاتيح Firebase السحابية بعد. يمكنك اللعب كزائر أو تسجيل الدخول التجريبي.');
    }
    try {
      const provider = new GoogleAuthProvider();
      provider.setCustomParameters({ prompt: 'select_account' });
      const result = await signInWithPopup(this.auth, provider);
      return result.user;
    } catch (error: any) {
      if (error.code === 'auth/popup-closed-by-user') {
        throw new Error('تم إغلاق نافذة تسجيل الدخول من قبل المستخدم.');
      } else if (error.code === 'auth/cancelled-popup-request') {
        throw new Error('تم إلغاء طلب تسجيل الدخول.');
      } else if (error.code === 'auth/unauthorized-domain') {
        throw new Error('النطاق الحالي غير مصرح به في Firebase Console. يرجى إضافة النطاق إلى Authorized Domains.');
      }
      throw error;
    }
  }

  public async loginWithEmail(email: string, pass: string): Promise<User | null> {
    if (!this.hasValidCloudConfig() || !this.auth) {
      throw new Error('لم يتم ضبط مفاتيح Firebase السحابية بعد. يمكنك الدخول كزائر فوراً.');
    }
    const res = await signInWithEmailAndPassword(this.auth, email, pass);
    return res.user;
  }

  public async registerWithEmail(email: string, pass: string, name: string): Promise<User | null> {
    if (!this.hasValidCloudConfig() || !this.auth) {
      throw new Error('لم يتم ضبط مفاتيح Firebase السحابية بعد. يمكنك الدخول كزائر فوراً.');
    }
    const res = await createUserWithEmailAndPassword(this.auth, email, pass);
    await updateProfile(res.user, { displayName: name });
    return res.user;
  }

  public async logout(): Promise<void> {
    if (this.auth) {
      await signOut(this.auth);
    }
  }

  // --- Profile Management ---
  public async getUserProfile(uid: string): Promise<UserProfile | null> {
    if (this.db) {
      try {
        const snap = await getDoc(doc(this.db, 'users', uid));
        if (snap.exists()) {
          return snap.data() as UserProfile;
        }
      } catch (e) {
        console.warn('Error fetching user profile from Firestore:', e);
      }
    }
    const local = localStorage.getItem(`monopoly_profile_${uid}`);
    return local ? JSON.parse(local) : null;
  }

  public async saveUserProfile(profile: UserProfile): Promise<void> {
    localStorage.setItem(`monopoly_profile_${profile.uid}`, JSON.stringify(profile));
    if (this.db) {
      try {
        await setDoc(doc(this.db, 'users', profile.uid), {
          ...profile,
          updatedAt: Date.now()
        }, { merge: true });
      } catch (e) {
        console.warn('Error saving profile to Firestore:', e);
      }
    }
  }

  // --- Send Message to Developer (Email + Cloud Archive) ---
  public async sendDeveloperMessage(payload: {
    name: string;
    email?: string;
    subjectType: string;
    message: string;
    userId?: string;
  }): Promise<{ success: boolean; error?: string }> {
    // 1. Send Email directly to Developer Inbox (amr.elhaj87@gmail.com) via FormSubmit
    try {
      await fetch('https://formsubmit.co/ajax/amr.elhaj87@gmail.com', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify({
          _subject: `[أملاك وعقارات] رسالة جديدة: ${payload.subjectType} من ${payload.name}`,
          _captcha: 'false',
          _template: 'table',
          'اسم المرسل': payload.name,
          'البريد الإلكتروني للرد': payload.email || 'لم يحدد',
          'نوع الرسالة': payload.subjectType,
          'نص الرسالة': payload.message,
          'معرف اللاعب': payload.userId || 'زائر',
          'وقت الإرسال': new Date().toLocaleString('ar-EG')
        })
      });
    } catch (err) {
      console.warn('FormSubmit notice:', err);
    }

    // 2. Archive a copy in Firestore collection 'developer_messages'
    if (this.db) {
      try {
        await addDoc(collection(this.db, 'developer_messages'), {
          ...payload,
          createdAt: Date.now()
        });
      } catch (e) {
        console.warn('Firestore message backup notice:', e);
      }
    }

    return { success: true };
  }
}

export const firebaseService = new FirebaseService();
