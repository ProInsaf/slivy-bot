const { Telegraf, Markup } = require('telegraf');
const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');
const dotenv = require('dotenv');
const COOLDOWN_MINUTES = 5;
const fiveMinutesAgo = new Date(Date.now() - COOLDOWN_MINUTES * 60 * 1000);

dotenv.config();
const bot = new Telegraf(process.env.BOT_TOKEN);

console.log('🚀 Запуск Telegram-бота...');

// Подключение к MongoDB
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('✅ MongoDB подключен!'))
  .catch(err => {
    console.error('❌ Ошибка MongoDB:', err.message);
    process.exit(1);
  });

// Схема пользователей
const userSchema = new mongoose.Schema({
  userId: { type: String, unique: true, required: true },
  username: String,
  isAdmin: { type: Boolean, default: false }
});
const User = mongoose.model('User', userSchema);

// Генератор промокода (8 uppercase алфанумерических символов)
function generatePromoCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  for (let i = 0; i < 8; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

// Схема pending оплат
const pendingPaymentSchema = new mongoose.Schema({
  userId: String,
  username: String,
  courseKey: String,
  photoFileId: String,
  status: { type: String, default: 'pending' }, // pending, approved, rejected
  createdAt: { type: Date, default: Date.now },
  lastRequestAt: { type: Date, default: Date.now } // ← НОВОЕ ПОЛЕ
});
const PendingPayment = mongoose.model('PendingPayment', pendingPaymentSchema);

// Схема промокодов (с expiresAt 30 дней)
const promoSchema = new mongoose.Schema({
  code: { type: String, unique: true, required: true },
  userId: { type: String, required: true },
  username: String,
  course: { type: String, required: true },
  deviceFingerprint: String,
  used: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now },
  expiresAt: { type: Date, default: () => new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) }  // 30 дней
});
const Promo = mongoose.model('Promo', promoSchema);

// Курсы с ценами и описаниями
const COURSES = {
  course_russian: {
    name: 'Подготовка к ЕГЭ: Русский язык',
    price: 499,
    description: 'Комплексный курс по русскому языку для ЕГЭ: видеоуроки, тесты, разбор заданий, практика сочинений и анализ типичных ошибок. Идеально для повышения баллов.'
  },
  course_history: {
    name: 'Подготовка к ЕГЭ: История',
    price: 499,
    description: 'Полный курс истории для ЕГЭ: хронология событий, ключевые даты, анализ источников, карты и задания на аргументацию. Подходит для всех уровней.'
  },
  course_social: {
    name: 'Подготовка к ЕГЭ: Обществознание',
    price: 499,
    description: 'Курс обществознания для ЕГЭ: темы права, экономики, политики, социологии. С примерами, тестами и эссе. Помогает структурировать знания.'
  },
  course_math: {
    name: 'ЕГЭ: Базовая математика',
    price: 499,
    description: 'Базовый курс математики для ЕГЭ: алгебра, геометрия, простые задачи. Видеоразборы,練習 тесты и советы по решению.'
  },
  course_soft: {
    name: 'Личностный трек от Умскул',
    price: 199,
    description: 'Персонализированный трек развития: мотивация, планирование, soft skills для учебы и экзаменов. Короткие уроки и упражнения для саморазвития.'
  },
  course_full: {
    name: 'Полный пакет ЕГЭ',
    price: 1499,
    description: 'Доступ ко всем курсам ЕГЭ: русский, история, обществознание, математика + личностный трек. Экономия и полный охват подготовки.'
  }
};

// Реквизиты оплаты (замените на реальные)
const PAYMENT_INFO = 'Переведите {price} руб на карту Тинькофф: +79063316937 (Нигматдинов И.). В комментарии укажите ваш @username для идентификации.';

// Глобальные переменные
const states = new Map();
let adminId = null;

// Сайт для активации промокода (замените на реальный URL)
const ACTIVATION_SITE = 'https://slivy-umskul.vercel.app/'; // Placeholder; замените на актуальную ссылку

// Регистрация пользователя
async function registerUser(ctx) {
  const userId = ctx.from.id.toString();
  const username = ctx.from.username;
  let user = await User.findOne({ userId });
  if (!user) {
    user = new User({ userId, username, isAdmin: username === 'insafbober' });
    await user.save();
  } else if (username === 'insafbober' && !user.isAdmin) {
    user.isAdmin = true;
    await user.save();
  }
  if (user.isAdmin) adminId = userId;
}

// /start
bot.start(async (ctx) => {
  await registerUser(ctx);
  states.delete(ctx.from.id.toString()); // Сброс состояния
  const name = ctx.from.first_name || 'друг';
  const keyboard = [
    [Markup.button.callback('📘 Русский язык - 499 руб', 'course_russian')],
    [Markup.button.callback('📜 История - 499 руб', 'course_history')],
    [Markup.button.callback('⚖️ Обществознание - 499 руб', 'course_social')],
    [Markup.button.callback('📐 Математика - 499 руб', 'course_math')],
    [Markup.button.callback('🧠 Личностный трек - 199 руб', 'course_soft')],
    [Markup.button.callback('🎯 Полный пакет - 1499 руб', 'course_full')],
    [Markup.button.callback('📞 Поддержка', 'support')]
  ];
  if (adminId === ctx.from.id.toString()) {
    keyboard.push([Markup.button.callback('🔧 Админ панель', 'admin_panel')]);
  }
  ctx.reply(
    `👋 Привет, ${name}!\n\nДобро пожаловать в *Сливы Умскул* 🎓\n\nЗдесь вы можете купить доступ к курсам на 30 дней.\nЦены в рублях за месяц.\nВыберите курс для подробностей и покупки:`,
    Markup.inlineKeyboard(keyboard)
  );
});

// Обработка выбора курса
bot.action(Object.keys(COURSES), async (ctx) => {
  await registerUser(ctx);
  const courseKey = ctx.callbackQuery.data;
  const course = COURSES[courseKey];
  const userId = ctx.from.id.toString();
  const username = ctx.from.username || 'Без username';

  await ctx.answerCbQuery();

  // Проверяем существующий активный промокод
  const existingPromo = await Promo.findOne({ 
    userId, 
    course: course.name, 
    used: false, 
    expiresAt: { $gt: new Date() } 
  });
  if (existingPromo) {
    return ctx.reply(`⚠️ Курс *${course.name}* уже куплен!\nПромокод: **${existingPromo.code}** (действует до ${existingPromo.expiresAt.toLocaleDateString('ru-RU')})\nАктивируй на сайте: ${ACTIVATION_SITE}.`, { parse_mode: 'Markdown' });
  }

  // Проверяем pending заявку
// ==== Проверка pending заявки ====
const lastRequest = await PendingPayment.findOne({
  userId,
  lastRequestAt: { $gt: fiveMinutesAgo }
}).sort({ lastRequestAt: -1 });

if (lastRequest) {
  const timePassed = Date.now() - lastRequest.lastRequestAt.getTime();
  const cooldownMs = COOLDOWN_MINUTES * 60 * 1000;
  const minutesLeft = Math.max(0, Math.ceil((cooldownMs - timePassed) / 60000));  // ← Math.max(0, ...) — фикс отрицательных
  
  if (minutesLeft > 0) {
    return ctx.reply(`⏳ Подождите ${minutesLeft} мин. перед новой заявкой.`);
  }
  // Если 0 или меньше — пропускаем, создаём новую
}

// ==== Создаём новую заявку ====
const pending = new PendingPayment({ 
  userId, 
  username, 
  courseKey,
  lastRequestAt: new Date()  // ← Обновляем время
});
await pending.save();

  // Инфо об оплате
  const paymentDetails = PAYMENT_INFO.replace('{price}', course.price);

  ctx.replyWithMarkdown(
    `📚 *Курс: ${course.name}*\n\n` +
    `📝 *Описание:* ${course.description}\n\n` +
    `💰 *Цена:* ${course.price} руб (за 30 дней доступа)\n\n` +
    `${paymentDetails}\n\n` +
    `После перевода отправьте скриншот чека (фото) в этот чат. Мы проверим и выдадим промокод.`
  );

  states.set(userId, `waiting_photo_${pending._id}`);
});

// Обработка фото (скриншот чека)
bot.on('photo', async (ctx) => {
  const userId = ctx.from.id.toString();
  const state = states.get(userId);
  if (state && state.startsWith('waiting_photo_')) {
    const pendingId = state.split('_')[2];
    const pending = await PendingPayment.findById(pendingId);
    if (pending && pending.userId === userId && pending.status === 'pending' && !pending.photoFileId) {
      pending.photoFileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
      await pending.save();
      ctx.reply('✅ Скриншот получен. Ожидайте проверки от администратора.');
      if (adminId) {
        const course = COURSES[pending.courseKey];
        bot.telegram.sendPhoto(adminId, pending.photoFileId, {
          caption: `Новая заявка на оплату:\nКурс: ${course.name}\nОт: @${pending.username} (ID: ${pending.userId})`,
          reply_markup: Markup.inlineKeyboard([
            [Markup.button.callback('✅ Одобрить', `approve_${pending._id}`), Markup.button.callback('❌ Отклонить', `reject_${pending._id}`)]
          ]).reply_markup
        });
      }
      states.delete(userId);
    } else {
      ctx.reply('❌ Заявка не найдена или уже обработана. Начните заново с /start.');
    }
  } else {
    ctx.reply('❌ Пожалуйста, сначала выберите курс для покупки.');
  }
});

// ==== Одобрение ====
// ==== Одобрение ====
bot.action(/approve_(.+)/, async (ctx) => {
  if (ctx.from.id.toString() !== adminId) return ctx.answerCbQuery('Доступ только админу.');
  const pendingId = ctx.match[1];
  const pending = await PendingPayment.findById(pendingId);
  if (!pending || pending.status !== 'pending') {
    return ctx.answerCbQuery('Заявка уже обработана или не найдена.');
  }

  pending.status = 'approved';
  await pending.save();

  // Генерация промокода
  let code;
  do {
    code = generatePromoCode();
  } while (await Promo.findOne({ code }));  // Уникальный код

  const course = COURSES[pending.courseKey];
  const promo = new Promo({ 
    code, 
    userId: pending.userId, 
    username: pending.username, 
    course: course.name 
  });
  await promo.save();

  // Уведомление пользователю
  await bot.telegram.sendMessage(pending.userId, 
    `✅ Ваша заявка одобрена!\nКурс: *${course.name}*\nПромокод: **${code}**\nДействует до: ${promo.expiresAt.toLocaleDateString('ru-RU')}\nАктивируйте на сайте: ${ACTIVATION_SITE}.`,
    { parse_mode: 'Markdown' }
  );

  // УДАЛЯЕМ запись
  await PendingPayment.deleteOne({ _id: pending._id });

  await ctx.answerCbQuery('Заявка одобрена.');
  await ctx.editMessageCaption(`Заявка одобрена. Промокод выдан.`);
});

// Отклонение заявки
// ==== Отклонение ====
bot.action(/reject_(.+)/, async (ctx) => {
  if (ctx.from.id.toString() !== adminId) return ctx.answerCbQuery('Доступ только админу.');
  const pendingId = ctx.match[1];
  const pending = await PendingPayment.findById(pendingId);
  if (!pending || pending.status !== 'pending') {
    return ctx.answerCbQuery('Заявка уже обработана или не найдена.');
  }

  pending.status = 'rejected';
  await pending.save();

  await bot.telegram.sendMessage(pending.userId, '❌ Ваша заявка отклонена. Пожалуйста, проверьте детали оплаты и попробуйте снова, или свяжитесь с поддержкой.');

  // ← УДАЛЯЕМ запись
  await PendingPayment.deleteOne({ _id: pending._id });

  await ctx.answerCbQuery('Заявка отклонена.');
  await ctx.editMessageCaption(`Заявка отклонена.`);
});

// Админ панель
bot.action('admin_panel', async (ctx) => {
  if (ctx.from.id.toString() !== adminId) return ctx.answerCbQuery('Доступ только админу.');
  await ctx.answerCbQuery();
  ctx.reply('🔧 Админ панель:', Markup.inlineKeyboard([
    [Markup.button.callback('📢 Рассылка всем', 'broadcast_start')]
  ]));
});

// Старт рассылки
bot.action('broadcast_start', async (ctx) => {
  if (ctx.from.id.toString() !== adminId) return ctx.answerCbQuery('Доступ только админу.');
  await ctx.answerCbQuery();
  ctx.reply('Введите текст для рассылки всем пользователям (кроме админа):');
  states.set(adminId, 'waiting_broadcast');
});

// Поддержка
bot.action('support', async (ctx) => {
  await ctx.answerCbQuery();
  ctx.reply('📞 Напишите ваше сообщение в поддержку. Мы ответим как можно скорее.\nДля выхода нажмите кнопку ниже или /start.', 
    Markup.inlineKeyboard([[Markup.button.callback('❌ Выйти', 'exit_support')]])
  );
  states.set(ctx.from.id.toString(), 'support_mode');
});

bot.action('exit_support', async (ctx) => {
  states.delete(ctx.from.id.toString());
  await ctx.answerCbQuery('Вы вышли из режима поддержки.');
  ctx.reply('Вы вышли из поддержки. Используйте /start для меню.');
});

// Обработка текстовых сообщений (для рассылки и поддержки)
bot.on('text', async (ctx) => {
  const userId = ctx.from.id.toString();
  const state = states.get(userId);
  if (state === 'waiting_broadcast' && userId === adminId) {
    const text = ctx.message.text;
    const users = await User.find({ isAdmin: false });
    let count = 0;
    for (const user of users) {
      try {
        await bot.telegram.sendMessage(user.userId, text);
        count++;
      } catch (err) {
        console.error(`Ошибка отправки пользователю ${user.userId}:`, err);
      }
    }
    ctx.reply(`✅ Рассылка завершена. Отправлено ${count} пользователям.`);
    states.delete(userId);
  } else if (state === 'support_mode') {
    const text = ctx.message.text;
    if (adminId) {
      await bot.telegram.sendMessage(adminId, `📩 Сообщение в поддержку от @${ctx.from.username || 'аноним'} (ID: ${userId}):\n\n${text}`);
    }
    ctx.reply('✅ Сообщение отправлено. Напишите следующее или выйдите.', 
      Markup.inlineKeyboard([[Markup.button.callback('❌ Выйти', 'exit_support')]])
    );
  } else {
    // Игнор или подсказка
    ctx.reply('Используйте /start для меню или выберите действие.');
  }
});

// Назад (если нужно, но убрали reset)
bot.action('back_to_start', (ctx) => ctx.reply('/start'));

// Ошибки
bot.catch((err, ctx) => {
  console.error('❌ Ошибка в боте:', err);
  ctx.reply('Произошла ошибка. Попробуй /start.');
});

// Запуск
bot.launch().then(() => console.log('✅ Бот запущен!')).catch(err => console.error('Ошибка запуска:', err));

// Остановка
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));