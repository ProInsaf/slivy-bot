// server.js (исправленный: в /validate-promo добавил лог для найденного промо и fallback-лог всех промо для device, если не найдено; убрал expired: false из findOne для новых кодов; улучшено логирование для дебага "истёкший")
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const dotenv = require('dotenv');

dotenv.config();
const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());  // Для POST

console.log('Запуск API сервера...');

// MongoDB
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('✅ MongoDB подключен для API!'))
  .catch(err => {
    console.error('❌ Ошибка MongoDB в API:', err.message);
    process.exit(1);
  });

// Схема
const promoSchema = new mongoose.Schema({
  code: { type: String, unique: true, required: true },
  userId: { type: String, required: true },
  username: String,
  course: { type: String, required: true },
  deviceFingerprint: String,
  used: { type: Boolean, default: false },
  expired: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now },
  expiresAt: { type: Date, default: () => {
    const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    console.log(`Default expiresAt: ${future.toISOString()}`);
    return future;
  }}
});

const Promo = mongoose.model('Promo', promoSchema);

// Проверка промокода (убрал expired из findOne — только expiresAt; set expired=false; добавил лог всех промо для device, если не найдено)
app.get('/validate-promo', async (req, res) => {
  const { code, deviceFingerprint } = req.query;
  console.log(`Запрос проверки: code=${code}, device=${deviceFingerprint?.slice(0, 10)}...`);

  if (!code || !deviceFingerprint) {
    return res.status(400).json({ success: false, msg: 'Отсутствуют code или deviceFingerprint' });
  }

  try {
    const promo = await Promo.findOne({
      code,
      used: false,
      expiresAt: { $gt: new Date() }  // Только не истёкшие, без expired (fallback)
    });

    if (!promo) {
      // Лог для дебага: все промо для device
      const allPromosForDevice = await Promo.find({ deviceFingerprint }).select('code course used expired expiresAt');
      console.log(`❌ Промо ${code} не найдено. Все промо для device:`, JSON.stringify(allPromosForDevice, null, 2));
      return res.status(400).json({ success: false, msg: 'Неверный, использованный или истёкший промокод' });
    }

    console.log(`Промо найдено: course=${promo.course}, used=${promo.used}, expired=${promo.expired}, expiresAt=${promo.expiresAt.toISOString()}, now=${new Date().toISOString()}`);

    if (promo.deviceFingerprint && promo.deviceFingerprint !== deviceFingerprint) {
      return res.status(400).json({ success: false, msg: 'Промокод привязан к другому устройству. Шаринг запрещён!' });
    }

    promo.deviceFingerprint = deviceFingerprint;
    promo.used = true;
    promo.expired = false;
    await promo.save();

    console.log(`✅ Промокод ${code} для курса ${promo.course} активирован (до ${promo.expiresAt.toLocaleDateString()})`);

    res.json({
      success: true,
      msg: 'Доступ к курсу активирован!',
      course: promo.course,
      expiresAt: promo.expiresAt.toISOString()
    });
  } catch (err) {
    console.error('❌ Ошибка в /validate-promo:', err);
    res.status(500).json({ success: false, msg: 'Серверная ошибка' });
  }
});

// Получить активированные (дедупликация по course с max expiresAt)
app.get('/get-activated', async (req, res) => {
  const { deviceFingerprint } = req.query;
  if (!deviceFingerprint) return res.status(400).json({ success: false, msg: 'Device required' });

  try {
    const now = new Date();
    console.log(`Запрос /get-activated, device=${deviceFingerprint.slice(0, 10)}..., now=${now.toISOString()}`);

    // Обновляем expired для истёкших
    const expiredPromos = await Promo.find({
      deviceFingerprint,
      used: true,
      expired: false,
      expiresAt: { $lte: now }
    });

    for (let promo of expiredPromos) {
      await Promo.findByIdAndUpdate(promo._id, { expired: true });
      console.log(`Set expired=true для промо ${promo.code} (expiresAt=${promo.expiresAt.toISOString()})`);
    }

    // Дедупликация: группируем по course, берём max expiresAt
    const pipeline = [
      { $match: {
          deviceFingerprint,
          used: true,
          expired: false,
          expiresAt: { $gt: now }
        }
      },
      { $group: {
          _id: "$course",
          latestExpiresAt: { $max: "$expiresAt" },
          expired: { $first: "$expired" },
          code: { $last: "$code" }  // Для лога
        }
      },
      { $project: {
          course: "$_id",
          expiresAt: "$latestExpiresAt",
          expired: 1,
          _id: 0
        }
      },
      { $sort: { expiresAt: -1 } }  // Сортировка по дате
    ];

    const uniquePromos = await Promo.aggregate(pipeline);

    const activated = uniquePromos.map(p => ({
      course: p.course,
      expiresAt: p.expiresAt.toISOString(),
      expired: p.expired || false
    }));

    console.log(`Уникальные активные промо: ${activated.length}, device=${deviceFingerprint.slice(0, 10)}...`);
    console.log("Возвращаемые промо:", JSON.stringify(activated, null, 2));
    res.json({ success: true, activated });
  } catch (err) {
    console.error('❌ Ошибка в /get-activated:', err);
    res.status(500).json({ success: false, msg: 'Ошибка' });
  }
});

// Эндпоинты для дебага
app.get('/promo/:code', async (req, res) => {
  try {
    const promo = await Promo.findOne({ code: req.params.code });
    if (!promo) return res.status(404).json({ success: false, msg: 'Промокод не найден' });
    res.json({
      success: true,
      promo: {
        code: promo.code,
        course: promo.course,
        expiresAt: promo.expiresAt.toISOString(),
        expired: promo.expired,
        used: promo.used
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, msg: 'Ошибка' });
  }
});

app.post('/promo/:code/extend', async (req, res) => {
  try {
    const { code } = req.params;
    const { days = 30 } = req.body;
    const promo = await Promo.findOne({ code });
    if (!promo) return res.status(404).json({ success: false, msg: 'Промокод не найден' });
    promo.expiresAt = new Date(promo.expiresAt.getTime() + days * 24 * 60 * 60 * 1000);
    promo.expired = false;
    await promo.save();
    res.json({ success: true, msg: `Продлено на ${days} дней. Новое expiresAt: ${promo.expiresAt.toISOString()}` });
  } catch (err) {
    res.status(500).json({ success: false, msg: 'Ошибка' });
  }
});

// Тест
app.get('/status', (req, res) => {
  res.json({ success: true, msg: 'API работает!' });
});

// Запуск
app.listen(PORT, () => {
  console.log(`✅ API на http://localhost:${PORT}`);
  console.log(`Debug: GET /promo/{code} — просмотр; POST /promo/{code}/extend {days:30} — продление (используй Postman)`);
});