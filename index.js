const express = require('express');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');
const cloudinary = require('cloudinary').v2;
const multer = require('multer');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const app = express();

// CORS Middleware - TAMBAHKAN INI
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  
  // Handle preflight requests
  if (req.method === 'OPTIONS') {
    res.sendStatus(200);
  } else {
    next();
  }
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Setup Multer untuk form-data
const upload = multer({ storage: multer.memoryStorage() });

// Inisialisasi Firebase
// initializeApp({
//   credential: cert('./pasarku-firebase-adminsdk.json'),
// });

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
initializeApp({
  credential: cert(serviceAccount),
});

const db = getFirestore();
const auth = getAuth();



// Inisialisasi Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Middleware untuk Verifikasi Token
const verifyToken = async (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) {
    return res.status(401).json({ error: 'Token diperlukan' });
  }
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await auth.getUser(decoded.uid);
    req.user = user;
    next();
  } catch (error) {
    res.status(401).json({ error: 'Token tidak valid' });
  }
};

app.get('/', (req, res) => {
  res.json({ message: 'API is running' });
});

// Register User (Updated with name, address, phoneNumber)
app.post('/api/register', upload.none(), async (req, res) => {
  const { email, password, name, address, phoneNumber } = req.body;
  try {
    if (!email || !password || !name || !address || !phoneNumber) {
      return res.status(400).json({ error: 'Email, password, nama, alamat, dan nomor telepon wajib' });
    }
    const userRecord = await auth.createUser({
      email,
      password,
    });
    await db.collection('users').doc(userRecord.uid).set({
      email,
      name,
      address,
      phoneNumber,
      role: 'user',
      createdAt: new Date().toISOString(),
    });
    res.json({ message: 'User berhasil register', uid: userRecord.uid });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Login User
app.post('/api/login', upload.none(), async (req, res) => {
  const { email, password } = req.body;
  try {
    if (!email || !password) {
      return res.status(400).json({ error: 'Email dan password wajib' });
    }
    const user = await auth.getUserByEmail(email);
    const token = jwt.sign({ uid: user.uid }, process.env.JWT_SECRET, { expiresIn: '1h' });
    res.json({ message: 'Login berhasil', token });
  } catch (error) {
    res.status(401).json({ error: 'Email atau password salah' });
  }
});

// Tambah ke Keranjang
app.post('/api/cart', verifyToken, upload.none(), async (req, res) => {
  const { merchantId, itemId, quantity } = req.body;
  try {
    if (!merchantId || !itemId || !quantity) {
      return res.status(400).json({ error: 'merchantId, itemId, dan quantity wajib' });
    }
    const quantityNum = parseInt(quantity);
    if (isNaN(quantityNum) || quantityNum <= 0) {
      return res.status(400).json({ error: 'Quantity harus berupa angka positif' });
    }

    const itemDoc = await db.collection('items').doc(itemId).get();
    if (!itemDoc.exists || itemDoc.data().merchantId !== merchantId) {
      return res.status(404).json({ error: 'Barang tidak ditemukan atau tidak terkait dengan merchant' });
    }

    const stockDoc = await db.collection('stocks').doc(itemId).get();
    if (!stockDoc.exists || stockDoc.data().quantity < quantityNum) {
      return res.status(400).json({ error: 'Stok tidak cukup' });
    }

    const cartRef = db.collection('carts').doc();
    await cartRef.set({
      userId: req.user.uid,
      merchantId,
      itemId,
      quantity: quantityNum,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    res.json({ message: 'Barang berhasil ditambahkan ke keranjang', id: cartRef.id });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});


// Ambil Daftar Keranjang User
app.get('/api/cart', verifyToken, async (req, res) => {
  try {
    const snapshot = await db.collection('carts')
      .where('userId', '==', req.user.uid)
      .get();
    
    const cartItems = await Promise.all(
      snapshot.docs.map(async doc => {
        const cartData = doc.data();
        const itemDoc = await db.collection('items').doc(cartData.itemId).get();
        const itemData = itemDoc.exists ? itemDoc.data() : {};
        const merchantDoc = await db.collection('merchants').doc(cartData.merchantId).get();
        const merchantData = merchantDoc.exists ? merchantDoc.data() : {};
        return {
          id: doc.id,
          ...cartData,
          item: itemData,
          merchant: merchantData,
        };
      })
    );

    res.json(cartItems);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update Item di Keranjang
app.put('/api/cart/:id', verifyToken, upload.none(), async (req, res) => {
  const { id } = req.params;
  let { merchantId, itemId, quantity } = req.body; // Menggunakan let untuk memungkinkan perubahan jika perlu
  try {
    // Validasi input
    if (!quantity) {
      return res.status(400).json({ error: 'Quantity wajib diisi' });
    }
    const quantityNum = parseInt(quantity);
    if (isNaN(quantityNum) || quantityNum <= 0) {
      return res.status(400).json({ error: 'Quantity harus berupa angka positif' });
    }

    const cartRef = db.collection('carts').doc(id);
    const cartDoc = await cartRef.get();
    if (!cartDoc.exists) {
      return res.status(404).json({ error: 'Item keranjang tidak ditemukan' });
    }
    if (cartDoc.data().userId !== req.user.uid) {
      return res.status(403).json({ error: 'Anda tidak memiliki akses untuk mengedit item ini' });
    }

    // Validasi item dan merchant (opsional, hanya jika ada perubahan)
    if (itemId && cartDoc.data().itemId !== itemId) {
      const itemDoc = await db.collection('items').doc(itemId).get();
      if (!itemDoc.exists || itemDoc.data().merchantId !== (merchantId || cartDoc.data().merchantId)) {
        return res.status(404).json({ error: 'Barang tidak ditemukan atau tidak terkait dengan merchant' });
      }
    } else {
      itemId = cartDoc.data().itemId; // Menggunakan let memungkinkan perubahan ini
    }

    if (merchantId && cartDoc.data().merchantId !== merchantId) {
      const itemDoc = await db.collection('items').doc(cartDoc.data().itemId).get();
      if (!itemDoc.exists || itemDoc.data().merchantId !== merchantId) {
        return res.status(400).json({ error: 'Merchant tidak sesuai dengan barang' });
      }
    } else {
      merchantId = cartDoc.data().merchantId; // Menggunakan let memungkinkan perubahan ini
    }

    // Validasi stok
    const stockDoc = await db.collection('stocks').doc(itemId).get();
    if (!stockDoc.exists || stockDoc.data().quantity < quantityNum) {
      return res.status(400).json({ error: 'Stok tidak cukup' });
    }

    // Update data cart
    await cartRef.update({
      quantity: quantityNum,
      merchantId,
      itemId,
      updatedAt: new Date().toISOString(),
    });

    res.json({ message: 'Item keranjang berhasil diperbarui', id });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Hapus Item dari Keranjang
app.delete('/api/cart/:id', verifyToken, async (req, res) => {
  const { id } = req.params;
  try {
    const cartRef = db.collection('carts').doc(id);
    const cartDoc = await cartRef.get();
    if (!cartDoc.exists) {
      return res.status(404).json({ error: 'Item keranjang tidak ditemukan' });
    }
    if (cartDoc.data().userId !== req.user.uid) {
      return res.status(403).json({ error: 'Anda tidak memiliki akses untuk menghapus item ini' });
    }

    await cartRef.delete();
    res.json({ message: 'Item keranjang berhasil dihapus', id });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});


// Ambil Profil User
app.get('/api/profile', verifyToken, async (req, res) => {
  try {
    const userDoc = await db.collection('users').doc(req.user.uid).get();
    if (!userDoc.exists) {
      return res.status(404).json({ error: 'Profil user tidak ditemukan' });
    }
    const userData = userDoc.data();
    res.json({
      uid: req.user.uid,
      email: userData.email,
      name: userData.name,
      address: userData.address,
      phoneNumber: userData.phoneNumber,
      role: userData.role,
      createdAt: userData.createdAt,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});


// Tambah Pedagang
app.post('/api/merchant', verifyToken, upload.single('photo'), async (req, res) => {
  const { name, category, lat, lng, norek } = req.body;
  try {
    if (!name || !category || !lat || !lng) {
      return res.status(400).json({ error: 'Nama, kategori, dan lokasi wajib' });
    }
    
    let photoUrl = '';
    if (req.file) {
      const result = await new Promise((resolve, reject) => {
        cloudinary.uploader.upload_stream({ folder: 'pasarku' }, (error, result) => {
          if (error) return reject(error);
          resolve(result);
        }).end(req.file.buffer);
      });
      photoUrl = result.secure_url;
    }
    
    const merchantRef = await db.collection('merchants').add({
      name,
      category,
      location: { lat: parseFloat(lat), lng: parseFloat(lng) },
      photoUrl,
      norek: norek || '', // Nomor rekening (opsional)
      createdAt: new Date().toISOString(),
      userId: req.user.uid,
    });
    
    res.json({ message: 'Toko Berhasil Ditambahkan', id: merchantRef.id });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Ambil Daftar Toko (Untuk Semua User)
app.get('/api/merchants', async (req, res) => {
  const { category, owned } = req.query;
  const token = req.headers.authorization?.split(' ')[1]; // Ambil token (opsional)

  try {
    let query = db.collection('merchants');
    let userId = null;

    // Jika ada token, verifikasi untuk menentukan userId
    if (token) {
      try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const user = await auth.getUser(decoded.uid);
        userId = user.uid;
      } catch (error) {
        // Jika token tidak valid, kita abaikan (user dianggap belum login)
        userId = null;
      }
    }

    // Filter toko milik user jika query owned=true dan userId ada
    if (owned === 'true' && userId) {
      query = query.where('userId', '==', userId);
    }

    // Filter berdasarkan kategori jika ada
    if (category) {
      query = query.where('category', '==', category);
    }

    const snapshot = await query.get();
    const merchants = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.json(merchants);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Tambah Barang (dengan stok awal dan gambar opsional)
app.post('/api/item', verifyToken, upload.single('photo'), async (req, res) => {
  const { merchantId, name, category, basePrice, quantity } = req.body;
  try {
    if (!merchantId || !name || !category || !basePrice || !quantity) {
      return res.status(400).json({ error: 'Data barang tidak lengkap, termasuk stok awal (quantity)' });
    }
    const initialQuantity = parseInt(quantity);
    if (isNaN(initialQuantity) || initialQuantity < 0) {
      return res.status(400).json({ error: 'Stok awal harus berupa angka positif' });
    }
    const merchantDoc = await db.collection('merchants').doc(merchantId).get();
    if (!merchantDoc.exists || merchantDoc.data().userId !== req.user.uid) {
      return res.status(403).json({ error: 'Merchant tidak ditemukan atau bukan milik Anda' });
    }
    let photoUrl = '';
    if (req.file) {
      const result = await new Promise((resolve, reject) => {
        cloudinary.uploader.upload_stream({ folder: 'pasarku/items' }, (error, result) => {
          if (error) return reject(error);
          resolve(result);
        }).end(req.file.buffer);
      });
      photoUrl = result.secure_url;
    }
    const itemRef = await db.collection('items').add({
      merchantId,
      name,
      category,
      basePrice: parseFloat(basePrice),
      photoUrl,
      quantity: initialQuantity,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      userId: req.user.uid,
    });
    await db.collection('stocks').doc(itemRef.id).set({
      itemId: itemRef.id,
      merchantId,
      quantity: initialQuantity,
      updatedAt: new Date().toISOString(),
      userId: req.user.uid,
    });
    res.json({ message: 'Barang dan stok awal berhasil ditambahkan', id: itemRef.id });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update Barang (dengan dukungan update gambar)
app.put('/api/item/:id', verifyToken, upload.single('photo'), async (req, res) => {
  const { id } = req.params;
  const { name, category, basePrice } = req.body;
  try {
    if (!name || !category || !basePrice) {
      return res.status(400).json({ error: 'Data barang tidak lengkap' });
    }
    const itemRef = db.collection('items').doc(id);
    const itemDoc = await itemRef.get();
    if (!itemDoc.exists) {
      return res.status(404).json({ error: 'Barang tidak ditemukan' });
    }
    if (itemDoc.data().userId !== req.user.uid) {
      return res.status(403).json({ error: 'Anda tidak memiliki akses untuk mengedit barang ini' });
    }

    // Prepare update data
    const updateData = {
      name,
      category,
      basePrice: parseFloat(basePrice),
      updatedAt: new Date().toISOString(),
    };

    // Handle photo upload if provided
    if (req.file) {
      const result = await new Promise((resolve, reject) => {
        cloudinary.uploader.upload_stream({ folder: 'pasarku/items' }, (error, result) => {
          if (error) return reject(error);
          resolve(result);
        }).end(req.file.buffer);
      });
      updateData.photoUrl = result.secure_url;
    }

    await itemRef.update(updateData);
    res.json({ message: 'Barang berhasil diperbarui' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Hapus Barang
app.delete('/api/item/:id', verifyToken, async (req, res) => {
  const { id } = req.params;
  try {
    const itemRef = db.collection('items').doc(id);
    const itemDoc = await itemRef.get();
    if (!itemDoc.exists) {
      return res.status(404).json({ error: 'Barang tidak ditemukan' });
    }
    if (itemDoc.data().userId !== req.user.uid) {
      return res.status(403).json({ error: 'Anda tidak memiliki akses untuk menghapus barang ini' });
    }
    await itemRef.delete();
    const stockSnapshot = await db.collection('stocks')
      .where('itemId', '==', id)
      .get();
    const batch = db.batch();
    stockSnapshot.docs.forEach(doc => {
      batch.delete(doc.ref);
    });
    await batch.commit();
    res.json({ message: 'Barang berhasil dihapus' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Ambil Daftar Barang (Untuk Semua User)
app.get('/api/items', async (req, res) => {
  const { merchantId, owned } = req.query;
  const token = req.headers.authorization?.split(' ')[1]; // Ambil token (opsional)

  try {
    if (!merchantId) {
      return res.status(400).json({ error: 'merchantId wajib' });
    }

    const merchantDoc = await db.collection('merchants').doc(merchantId).get();
    if (!merchantDoc.exists) {
      return res.status(404).json({ error: 'Merchant tidak ditemukan' });
    }

    let query = db.collection('items').where('merchantId', '==', merchantId);
    let userId = null;

    // Jika ada token, verifikasi untuk menentukan userId
    if (token) {
      try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const user = await auth.getUser(decoded.uid);
        userId = user.uid;
      } catch (error) {
        // Jika token tidak valid, kita abaikan (user dianggap belum login)
        userId = null;
      }
    }

    // Filter barang milik user jika query owned=true dan userId ada
    if (owned === 'true' && userId) {
      query = query.where('userId', '==', userId);
      // Pastikan user adalah pemilik merchant
      if (merchantDoc.data().userId !== userId) {
        return res.status(403).json({ error: 'Merchant bukan milik Anda' });
      }
    }

    const snapshot = await query.get();
    const items = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.json(items);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update Stok
app.post('/api/stock', verifyToken, upload.none(), async (req, res) => {
  const { itemId, merchantId, quantity } = req.body;
  try {
    if (!itemId || !merchantId || !quantity) {
      return res.status(400).json({ error: 'Data stok tidak lengkap' });
    }
    const itemDoc = await db.collection('items').doc(itemId).get();
    if (!itemDoc.exists || itemDoc.data().merchantId !== merchantId) {
      return res.status(404).json({ error: 'Barang tidak ditemukan atau tidak terkait dengan merchant' });
    }
    if (itemDoc.data().userId !== req.user.uid) {
      return res.status(403).json({ error: 'Anda tidak memiliki akses untuk mengelola stok ini' });
    }
    const stockRef = db.collection('stocks').doc(`${itemId}`);
    await stockRef.set({
      itemId,
      merchantId,
      quantity: parseInt(quantity),
      updatedAt: new Date().toISOString(),
      userId: req.user.uid,
    });
    res.json({ message: 'Stok diperbarui' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Ambil Stok
app.get('/api/stock', async (req, res) => {
  const { merchantId } = req.query;
  try {
    let query = db.collection('stocks');
    if (merchantId) query = query.where('merchantId', '==', merchantId);
    const snapshot = await query.get();
    const stocks = await Promise.all(
      snapshot.docs.map(async doc => {
        const stockData = doc.data();
        const itemDoc = await db.collection('items').doc(stockData.itemId).get();
        const itemData = itemDoc.exists ? itemDoc.data() : {};
        return {
          id: doc.id,
          ...stockData,
          item: itemData,
        };
      })
    );
    res.json(stocks);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Mencari Produk (Filter: nama barang, kategori opsional, termurah, termahal)
app.get('/api/product/search', async (req, res) => {
  const { name, category, sortBy } = req.query;
  try {
    // Ambil semua stok
    let query = db.collection('stocks');
    
    // Filter berdasarkan kategori toko (opsional)
    if (category) {
      const merchantSnapshot = await db.collection('merchants')
        .where('category', '==', category)
        .get();
      const merchantIds = merchantSnapshot.docs.map(doc => doc.id);
      if (merchantIds.length === 0) {
        return res.json([]);
      }
      query = query.where('merchantId', 'in', merchantIds);
    }

    const snapshot = await query.get();
    let products = await Promise.all(
      snapshot.docs.map(async doc => {
        const stockData = doc.data();
        const itemDoc = await db.collection('items').doc(stockData.itemId).get();
        const itemData = itemDoc.exists ? itemDoc.data() : {};
        // Ambil data toko untuk informasi tambahan (opsional)
        const merchantDoc = await db.collection('merchants').doc(stockData.merchantId).get();
        const merchantData = merchantDoc.exists ? merchantDoc.data() : {};

        return {
          id: doc.id,
          ...stockData,
          item: itemData,
          merchant: merchantData,
        };
      })
    );

    // Filter berdasarkan nama barang (case-insensitive)
    if (name) {
      const searchTerm = name.toLowerCase();
      products = products.filter(product =>
        product.item.name.toLowerCase().includes(searchTerm)
      );
    }

    // Sorting
    if (sortBy) {
      if (sortBy === 'termurah') {
        // Urutkan berdasarkan harga (termurah ke termahal)
        products = products.sort((a, b) => a.item.basePrice - b.item.basePrice);
      } else if (sortBy === 'termahal') {
        // Urutkan berdasarkan harga (termahal ke termurah)
        products = products.sort((a, b) => b.item.basePrice - a.item.basePrice);
      }
    }

    res.json(products);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Melakukan Pemesanan
app.post('/api/order', verifyToken, upload.single('paymentProof'), async (req, res) => {
  const { merchantId, itemId, quantity, deliveryMethod, paymentMethod, address } = req.body;
  try {
    // Validasi input
    if (!merchantId || !itemId || !quantity || !deliveryMethod || !paymentMethod) {
      return res.status(400).json({ error: 'Data pemesanan tidak lengkap' });
    }
    if (!['delivery', 'pickup'].includes(deliveryMethod)) {
      return res.status(400).json({ error: 'Metode pengiriman harus delivery atau pickup' });
    }
    if (!['cod', 'digital'].includes(paymentMethod)) {
      return res.status(400).json({ error: 'Metode pembayaran harus cod atau digital' });
    }
    if (deliveryMethod === 'delivery' && !address) {
      return res.status(400).json({ error: 'Alamat wajib untuk pengiriman delivery' });
    }
    if (paymentMethod === 'digital' && !req.file) {
      return res.status(400).json({ error: 'Bukti pembayaran wajib untuk metode digital' });
    }

    // Validasi stok
    const stockRef = db.collection('stocks').doc(itemId);
    const stockDoc = await stockRef.get();
    if (!stockDoc.exists) {
      return res.status(404).json({ error: 'Produk tidak ditemukan' });
    }
    const stockData = stockDoc.data();
    if (stockData.quantity < parseInt(quantity)) {
      return res.status(400).json({ error: 'Stok tidak cukup' });
    }

    // Validasi item
    const itemDoc = await db.collection('items').doc(itemId).get();
    if (!itemDoc.exists) {
      return res.status(404).json({ error: 'Item tidak ditemukan' });
    }
    const itemData = itemDoc.data();

    // Hitung total
    const total = parseInt(quantity) * itemData.basePrice;

    // Upload bukti pembayaran jika ada
    let paymentProofUrl = '';
    if (req.file) {
      const result = await new Promise((resolve, reject) => {
        cloudinary.uploader.upload_stream(
          { folder: `pasarku/payment-proofs/${req.user.uid}` },
          (error, result) => {
            if (error) return reject(error);
            resolve(result);
          }
        ).end(req.file.buffer);
      });
      paymentProofUrl = result.secure_url;
    }

    // Simpan pesanan
    const orderRef = await db.collection('orders').add({
      userId: req.user.uid,
      merchantId,
      itemId,
      item: itemData.name,
      quantity: parseInt(quantity),
      price: itemData.basePrice,
      total,
      deliveryMethod,
      paymentMethod,
      paymentProof: paymentProofUrl,
      status: 'konfirmasi pembayaran',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      address: deliveryMethod === 'delivery' ? address : null,
    });

    // Update stok
    await stockRef.update({
      quantity: stockData.quantity - parseInt(quantity),
    });

    res.json({ message: 'Pemesanan berhasil', id: orderRef.id });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Ambil Pemesanan User
app.get('/api/order', verifyToken, async (req, res) => {
  try {
    const snapshot = await db.collection('orders')
      .where('userId', '==', req.user.uid)
      .get();
    const orders = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.json(orders);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Ambil Pesanan untuk Pedagang
app.get('/api/merchant/orders', verifyToken, async (req, res) => {
  const { merchantId } = req.query;
  try {
    if (!merchantId) {
      return res.status(400).json({ error: 'merchantId wajib' });
    }
    const merchantDoc = await db.collection('merchants').doc(merchantId).get();
    if (!merchantDoc.exists || merchantDoc.data().userId !== req.user.uid) {
      return res.status(403).json({ error: 'Merchant tidak ditemukan atau bukan milik Anda' });
    }
    const snapshot = await db.collection('orders')
      .where('merchantId', '==', merchantId)
      .get();
    const orders = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.json(orders);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update Status Pesanan
app.patch('/api/order/:id/status', verifyToken, async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  try {
    if (!status || !['pending', 'shipped', 'completed', 'canceled'].includes(status)) {
      return res.status(400).json({ error: 'Status tidak valid. Gunakan: pending, shipped, completed, canceled' });
    }
    const orderRef = db.collection('orders').doc(id);
    const orderDoc = await orderRef.get();
    if (!orderDoc.exists) {
      return res.status(404).json({ error: 'Pesanan tidak ditemukan' });
    }
    const orderData = orderDoc.data();
    const merchantDoc = await db.collection('merchants').doc(orderData.merchantId).get();
    if (!merchantDoc.exists || merchantDoc.data().userId !== req.user.uid) {
      return res.status(403).json({ error: 'Anda tidak memiliki akses untuk mengupdate pesanan ini' });
    }
    await orderRef.update({ status, updatedAt: new Date().toISOString() });
    res.json({ message: 'Status pesanan diperbarui' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Dashboard Penjualan dan Analisis
app.get('/api/dashboard', verifyToken, async (req, res) => {
  const { merchantId } = req.query;
  try {
    if (!merchantId) {
      return res.status(400).json({ error: 'merchantId wajib' });
    }
    const merchantDoc = await db.collection('merchants').doc(merchantId).get();
    if (!merchantDoc.exists || merchantDoc.data().userId !== req.user.uid) {
      return res.status(403).json({ error: 'Merchant tidak ditemukan atau bukan milik Anda' });
    }
    const ordersSnapshot = await db.collection('orders')
      .where('merchantId', '==', merchantId)
      .get();
    const orders = ordersSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    const totalSales = orders
      .filter(order => order.status === 'completed')
      .reduce((sum, order) => sum + order.total, 0);
    const ordersByStatus = orders.reduce((acc, order) => {
      acc[order.status] = (acc[order.status] || 0) + 1;
      return acc;
    }, {});
    const productSales = orders.reduce((acc, order) => {
      const key = order.item;
      if (!acc[key]) {
        acc[key] = { item: order.item, count: 0, totalQuantity: 0 };
      }
      acc[key].count += 1;
      acc[key].totalQuantity += order.quantity;
      return acc;
    }, {});
    const topProducts = Object.values(productSales)
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);
    res.json({
      totalSales,
      ordersByStatus,
      topProducts,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Send Message to Store
app.post('/api/send-message', verifyToken, upload.none(), async (req, res) => {
  const { storeName, message } = req.body;
  try {
    if (!storeName || !message) {
      return res.status(400).json({ error: 'Nama toko dan pesan wajib' });
    }

    const merchantDoc = await db.collection('merchants').doc(storeName).get();
    if (!merchantDoc.exists) {
      return res.status(404).json({ error: 'Toko tidak ditemukan' });
    }

    const messageRef = await db.collection('messages').add({
      userId: req.user.uid,
      merchantId: storeName,
      message,
      createdAt: new Date().toISOString(),
      status: 'unread',
    });

    res.json({ message: 'Pesan berhasil dikirim', id: messageRef.id });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get Messages for Store Dashboard
app.get('/api/merchant/messages', verifyToken, async (req, res) => {
  const { merchantId } = req.query;
  try {
    if (!merchantId) {
      return res.status(400).json({ error: 'merchantId wajib' });
    }

    const merchantDoc = await db.collection('merchants').doc(merchantId).get();
    if (!merchantDoc.exists || merchantDoc.data().userId !== req.user.uid) {
      return res.status(403).json({ error: 'Merchant tidak ditemukan atau bukan milik Anda' });
    }

    const snapshot = await db.collection('messages')
      .where('merchantId', '==', merchantId)
      .get();

    const messages = await Promise.all(
      snapshot.docs.map(async doc => {
        const messageData = doc.data();
        const userDoc = await db.collection('users').doc(messageData.userId).get();
        const userData = userDoc.exists ? userDoc.data() : {};
        return {
          id: doc.id,
          ...messageData,
          user: {
            name: userData.name || 'Unknown',
            email: userData.email || 'N/A',
          },
        };
      })
    );

    res.json(messages);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Ambil Semua Pesanan (Untuk Owner)
app.get('/api/owner/orders', verifyToken, async (req, res) => {
  try {
    // Cek peran pengguna
    const userDoc = await db.collection('users').doc(req.user.uid).get();
    if (!userDoc.exists || userDoc.data().role !== 'owner') {
      return res.status(403).json({ error: 'Hanya pengguna dengan peran owner yang dapat mengakses data ini' });
    }

    // Ambil semua pesanan
    const snapshot = await db.collection('orders').get();
    const orders = await Promise.all(
      snapshot.docs.map(async doc => {
        const orderData = doc.data();
        // Ambil data merchant (opsional)
        const merchantDoc = await db.collection('merchants').doc(orderData.merchantId).get();
        const merchantData = merchantDoc.exists ? merchantDoc.data() : {};
        // Ambil data user (opsional)
        const userDoc = await db.collection('users').doc(orderData.userId).get();
        const userData = userDoc.exists ? userDoc.data() : {};
        return {
          id: doc.id,
          ...orderData,
          merchant: {
            name: merchantData.name || 'Unknown',
            category: merchantData.category || 'N/A',
          },
          user: {
            name: userData.name || 'Unknown',
            email: userData.email || 'N/A',
          },
        };
      })
    );

    res.json(orders);
  } catch (error) {
    console.error('Error fetching all orders:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Update Status Pesanan (Untuk Owner)
app.patch('/api/owner/order/:id/status', verifyToken, async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  try {
    // Cek peran pengguna
    const userDoc = await db.collection('users').doc(req.user.uid).get();
    if (!userDoc.exists || userDoc.data().role !== 'owner') {
      return res.status(403).json({ error: 'Hanya pengguna dengan peran owner yang dapat mengubah status pesanan' });
    }

    // Validasi status
    if (!status || !['pending', 'shipped', 'completed', 'canceled'].includes(status)) {
      return res.status(400).json({ error: 'Status tidak valid. Gunakan: pending, shipped, completed, canceled' });
    }

    // Cek keberadaan pesanan
    const orderRef = db.collection('orders').doc(id);
    const orderDoc = await orderRef.get();
    if (!orderDoc.exists) {
      return res.status(404).json({ error: 'Pesanan tidak ditemukan' });
    }

    // Update status pesanan
    await orderRef.update({
      status,
      updatedAt: new Date().toISOString(),
    });

    res.json({ message: 'Status pesanan berhasil diperbarui', id });
  } catch (error) {
    console.error('Error updating order status:', error.message);
    res.status(500).json({ error: error.message });
  }
});


const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server jalan di port ${PORT}`));

// Ekspor app untuk Vercel
module.exports = app;

//deploy perubahan angel

//deploy perubahan angel 2