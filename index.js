const express = require('express');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');
const cloudinary = require('cloudinary').v2;
const multer = require('multer');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const app = express();
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

// Register User
app.post('/api/register', upload.none(), async (req, res) => {
  const { email, password } = req.body;
  try {
    if (!email || !password) {
      return res.status(400).json({ error: 'Email dan password wajib' });
    }
    const userRecord = await auth.createUser({
      email,
      password,
    });
    await db.collection('users').doc(userRecord.uid).set({
      email,
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

// Tambah Pedagang
app.post('/api/merchant', verifyToken, upload.single('photo'), async (req, res) => {
  const { name, category, lat, lng } = req.body;
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

// Tambah Barang (dengan stok awal)
app.post('/api/item', verifyToken, upload.none(), async (req, res) => {
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
    const itemRef = await db.collection('items').add({
      merchantId,
      name,
      category,
      basePrice: parseFloat(basePrice),
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

// Update Barang
app.put('/api/item/:id', verifyToken, upload.none(), async (req, res) => {
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
    await itemRef.update({
      name,
      category,
      basePrice: parseFloat(basePrice),
      updatedAt: new Date().toISOString(),
    });
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
app.post('/api/order', verifyToken, upload.none(), async (req, res) => {
  const { merchantId, itemId, quantity, deliveryMethod, paymentMethod, address } = req.body;
  try {
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
    const stockRef = db.collection('stocks').doc(itemId);
    const stockDoc = await stockRef.get();
    if (!stockDoc.exists) {
      return res.status(404).json({ error: 'Produk tidak ditemukan' });
    }
    const stockData = stockDoc.data();
    if (stockData.quantity < parseInt(quantity)) {
      return res.status(400).json({ error: 'Stok tidak cukup' });
    }

    const itemDoc = await db.collection('items').doc(itemId).get();
    if (!itemDoc.exists) {
      return res.status(404).json({ error: 'Item tidak ditemukan' });
    }
    const itemData = itemDoc.data();

    const total = parseInt(quantity) * itemData.basePrice;
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
      status: 'pending',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      address: deliveryMethod === 'delivery' ? address : null,
    });

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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server jalan di port ${PORT}`));

// Ekspor app untuk Vercel
module.exports = app;