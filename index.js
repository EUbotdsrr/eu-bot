const { Client, GatewayIntentBits, EmbedBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits, ChannelType, Collection } = require('discord.js');
const http = require('http');
const fs = require('fs');

// ========== НАСТРОЙКИ КЛИЕНТА ==========
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildBans,
    GatewayIntentBits.GuildInvites
  ]
});

// ========== ХРАНИЛИЩА В ПАМЯТИ ==========
const globalBackup = new Collection();
const deletedChannels = new Collection();
const activeTickets = new Collection();
const autoDeleteTimeouts = new Collection();
const timedOutUsers = new Collection();
let staffStats = new Collection();
const invites = new Collection();

// Хранилища для второго функционала
const pendingSends = new Collection();
const events = new Collection();
const leavePanels = new Map();

// ========== ПЕРЕМЕННЫЕ СОСТОЯНИЯ ==========
let ticketStatus = true;
let stats = {
  accepted: 0,
  denied: 0,
  autoDenied: 0,
  weekAccepted: 0,
  weekDenied: 0,
  weekStart: Date.now()
};

const startTime = Date.now();

// ========== ПОЛУЧЕНИЕ КОНФИГУРАЦИИ ==========
const getConfig = () => {
  return {
    token: process.env.DISCORD_TOKEN,
    // Сервер 1 (основной, с тикетами)
    guild1_id: process.env.GUILD1_ID,
    ticketCategory: process.env.TICKET_CATEGORY,
    staffRoleId: process.env.STAFF_ROLE_STACK1,
    logChannelId_guild1: process.env.LOG_CHANNEL_GUILD1,
    memberRoleId: process.env.MEMBER_ROLE_ID,
    autoRoleId: process.env.AUTO_ROLE_ID,
    // Сервер 2 (с варнами)
    guild2_id: process.env.GUILD2_ID,
    staffRoleId_guild2: process.env.STAFF_ROLE_GUILD2,
    logChannelId_guild2: process.env.LOG_CHANNEL_GUILD2,
    appealCategoryId: process.env.APPEAL_CATEGORY_ID
  };
};

// ========== ПРОВЕРКА ПРАВ ==========
function hasStaffPermission(member, guildId) {
  const cfg = getConfig();
  
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  
  if (guildId === cfg.guild1_id) {
    return cfg.staffRoleId && member.roles.cache.has(cfg.staffRoleId);
  } else if (guildId === cfg.guild2_id) {
    return cfg.staffRoleId_guild2 && member.roles.cache.has(cfg.staffRoleId_guild2);
  }
  
  return false;
}

// ========== ФУНКЦИИ АПТАЙМА ==========
function getUptime() {
  const diff = Date.now() - startTime;
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
  const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
  const seconds = Math.floor((diff % (1000 * 60)) / 1000);
  
  let result = '';
  if (days > 0) result += `${days} д. `;
  if (hours > 0) result += `${hours} ч. `;
  if (minutes > 0) result += `${minutes} мин. `;
  result += `${seconds} сек.`;
  return result;
}

function getWorkingHoursMessage() {
  const now = new Date();
  const mskHour = (now.getUTCHours() + 3) % 24;
  if (mskHour >= 10 && mskHour < 21) return '';
  return `\n**━━━━━━━━━━━━━━━━━━━━━━━━━━**\n⏰ *Заявки рассматриваются с 10:00 до 21:00 по МСК.*`;
}

async function sendLog(guild, embed) {
  try {
    const cfg = getConfig();
    const logChannelId = guild.id === cfg.guild1_id ? cfg.logChannelId_guild1 : cfg.logChannelId_guild2;
    if (!logChannelId) {
      console.log('⚠️ LOG_CHANNEL_ID не установлен');
      return;
    }
    const channel = await guild.channels.fetch(logChannelId).catch(() => null);
    if (!channel) {
      console.log('⚠️ Канал логов не найден');
      return;
    }
    await channel.send({ embeds: [embed] });
    console.log('✅ Лог отправлен');
  } catch (error) {
    console.error('❌ Ошибка отправки лога:', error);
  }
}

// ========== ОБНОВЛЕНИЕ РОЛИ СТАФФА ==========
async function updateStaffRole(guild, staffId, acceptedCount) {
  try {
    const member = await guild.members.fetch(staffId).catch(() => null);
    if (!member) return;
    
    const roleName = `📋 Принял ${acceptedCount} заявок`;
    
    const oldRoles = member.roles.cache.filter(r => r.name.startsWith('📋 Принял '));
    for (const role of oldRoles.values()) {
      await member.roles.remove(role).catch(() => {});
      if (role.members.size === 1) {
        await role.delete().catch(() => {});
      }
    }
    
    let newRole = guild.roles.cache.find(r => r.name === roleName);
    if (!newRole) {
      newRole = await guild.roles.create({
        name: roleName,
        color: 0x3498DB,
        reason: `Статистика принятых заявок для ${member.user.tag}`
      });
    }
    
    await member.roles.add(newRole);
    console.log(`✅ Роль "${roleName}" выдана ${member.user.tag}`);
  } catch (error) {
    console.error(`❌ Ошибка обновления роли:`, error);
  }
}

// ========== ОЧИСТКА ПРОСРОЧЕННЫХ ВАРНОВ ==========
async function cleanExpiredWarns(guild) {
  const now = new Date();
  const warnRoles = guild.roles.cache.filter(r => r.name.startsWith('⚠️ Warn ('));

  for (const role of warnRoles.values()) {
    const nameMatch = role.name.match(/⚠️ Warn \((\d{2}\.\d{2}\.\d{4})\) \[(\d+)д\]/);
    if (!nameMatch) continue;
    
    const dateStr = nameMatch[1];
    const durationDays = parseInt(nameMatch[2]);
    
    const [day, month, year] = dateStr.split('.');
    const issueDate = new Date(`${year}-${month}-${day}`);
    const expireDate = new Date(issueDate);
    expireDate.setDate(expireDate.getDate() + durationDays);
    
    if (now >= expireDate) {
      console.log(`🗑️ Удаляем просроченный варн: ${role.name}`);
      
      for (const member of role.members.values()) {
        await member.roles.remove(role).catch(() => {});
      }
      
      if (role.members.size === 0) {
        await role.delete().catch(() => {});
      }
    }
  }
}

// ========== СНЯТИЕ ВСЕХ ВАРНОВ С ПОЛЬЗОВАТЕЛЯ ==========
async function removeAllWarns(member) {
  const warnRoles = member.roles.cache.filter(r => r.name.startsWith('⚠️ Warn ('));
  
  for (const role of warnRoles.values()) {
    await member.roles.remove(role).catch(() => {});
    
    if (role.members.size === 0) {
      await role.delete().catch(() => {});
    }
  }
  
  return warnRoles.size;
}

// ========== СИСТЕМА ТИКЕТОВ ==========
function scheduleInactiveDelete(channelId, ticketId) {
  const timeout = setTimeout(async () => {
    try {
      const channel = await client.channels.fetch(channelId).catch(() => null);
      if (channel) {
        const messages = await channel.messages.fetch({ limit: 5 });
        const botMessages = messages.filter(m => m.author.id === client.user.id);
        
        if (messages.size <= 1 || (messages.size === 2 && botMessages.size >= 1)) {
          await channel.send('🗑️ **Тикет автоматически закрыт (неактивность 48 часов).**');
          setTimeout(async () => {
            try { await channel.delete(); } catch (error) {}
          }, 5000);
        }
      }
      activeTickets.delete(ticketId);
      autoDeleteTimeouts.delete(ticketId);
    } catch (error) {}
  }, 48 * 60 * 60 * 1000);
  
  autoDeleteTimeouts.set(ticketId, timeout);
}

async function createTicketMessage(channel) {
  const embed = new EmbedBuilder()
    .setTitle('📋 ПОДАТЬ ЗАЯВКУ В КЛАН EU')
    .setDescription(
      `**ТРЕБОВАНИЯ:**\n\n` +
      `● 3500 часов на аккаунте и более\n● 15+ лет\n● Иметь хороший микрофон\n` +
      `● Умение слушать коллы и адекватно реагировать на критику\n● Минимум 6 часов стабильного онлайна в день\n\n` +
      `**Статус набора:** ${ticketStatus ? '🟢 Открыт' : '🔴 Закрыт'}\n\nНажмите кнопку ниже, чтобы заполнить анкету.`
    )
    .setColor(0x3498DB)
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('create_ticket').setLabel('📝 Подать заявку').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('toggle_ticket').setEmoji(ticketStatus ? '🟢' : '🔴').setStyle(ButtonStyle.Secondary)
  );

  return await channel.send({ embeds: [embed], components: [row] });
}

function isTicketChannel(channel) {
  if (channel.name.startsWith('🎫｜')) return true;
  return false;
}

// ========== СОХРАНЕНИЕ СТРУКТУРЫ КАНАЛОВ В ГЛОБАЛЬНУЮ ПАМЯТЬ ==========
async function saveToGlobalBackup(guild) {
  try {
    const categories = [];
    const standaloneChannels = [];
    
    for (const channel of guild.channels.cache.values()) {
      if (isTicketChannel(channel)) continue;
      
      if (channel.type === ChannelType.GuildCategory) {
        categories.push({
          name: channel.name,
          type: 'category',
          position: channel.position,
          channels: []
        });
      }
    }
    
    for (const channel of guild.channels.cache.values()) {
      if (isTicketChannel(channel)) continue;
      
      if (channel.type === ChannelType.GuildText || channel.type === ChannelType.GuildVoice) {
        const channelData = {
          name: channel.name,
          type: channel.type === ChannelType.GuildText ? 'text' : 'voice',
          parentName: channel.parent?.name || null,
          position: channel.position,
          topic: channel.topic || null,
          nsfw: channel.nsfw || false,
          rateLimitPerUser: channel.rateLimitPerUser || 0,
          bitrate: channel.bitrate || null,
          userLimit: channel.userLimit || null
        };
        
        if (channel.parent) {
          const category = categories.find(c => c.name === channel.parent.name);
          if (category) category.channels.push(channelData);
        } else {
          standaloneChannels.push(channelData);
        }
      }
    }
    
    const backupData = {
      sourceGuildId: guild.id,
      sourceGuildName: guild.name,
      savedAt: new Date().toISOString(),
      savedBy: 'global_backup',
      categories: categories,
      standaloneChannels: standaloneChannels,
      totalChannels: categories.reduce((acc, cat) => acc + cat.channels.length, 0) + standaloneChannels.length
    };
    
    globalBackup.set('last_backup', backupData);
    
    console.log(`🌍 ГЛОБАЛЬНЫЙ БЭКАП сохранён: ${categories.length} категорий, ${backupData.totalChannels} каналов`);
    
    return backupData;
  } catch (error) {
    console.error('❌ Ошибка сохранения в глобальный бэкап:', error);
    return null;
  }
}

// ========== ВОССТАНОВЛЕНИЕ ИЗ ГЛОБАЛЬНОГО БЭКАПА ==========
async function restoreFromGlobalBackup(guild) {
  try {
    const backupData = globalBackup.get('last_backup');
    
    if (!backupData) {
      return { success: false, error: '❌ Глобальный бэкап не создан! Сначала используйте /save_backup на сервере-источнике.' };
    }
    
    let createdCategories = 0;
    let createdChannels = 0;
    const categoryMap = new Map();
    
    for (const cat of backupData.categories) {
      try {
        const existing = guild.channels.cache.find(c => c.type === ChannelType.GuildCategory && c.name === cat.name);
        if (!existing) {
          const newCategory = await guild.channels.create({
            name: cat.name,
            type: ChannelType.GuildCategory,
            position: cat.position
          });
          categoryMap.set(cat.name, newCategory.id);
          createdCategories++;
          await new Promise(resolve => setTimeout(resolve, 500));
        } else {
          categoryMap.set(cat.name, existing.id);
        }
      } catch (e) {
        console.error(`❌ Ошибка категории ${cat.name}:`, e.message);
      }
    }
    
    for (const cat of backupData.categories) {
      for (const ch of cat.channels) {
        try {
          const parentId = categoryMap.get(ch.parentName);
          
          const existing = guild.channels.cache.find(c => c.name === ch.name && c.parentId === parentId);
          if (!existing) {
            if (ch.type === 'text') {
              await guild.channels.create({
                name: ch.name,
                type: ChannelType.GuildText,
                parent: parentId,
                position: ch.position,
                topic: ch.topic || undefined,
                nsfw: ch.nsfw || false,
                rateLimitPerUser: ch.rateLimitPerUser || 0
              });
            } else if (ch.type === 'voice') {
              await guild.channels.create({
                name: ch.name,
                type: ChannelType.GuildVoice,
                parent: parentId,
                position: ch.position,
                bitrate: ch.bitrate || 64000,
                userLimit: ch.userLimit || 0
              });
            }
            createdChannels++;
            await new Promise(resolve => setTimeout(resolve, 500));
          }
        } catch (e) {
          console.error(`❌ Ошибка канала ${ch.name}:`, e.message);
        }
      }
    }
    
    for (const ch of backupData.standaloneChannels) {
      try {
        const existing = guild.channels.cache.find(c => c.name === ch.name && !c.parentId);
        if (!existing) {
          if (ch.type === 'text') {
            await guild.channels.create({
              name: ch.name,
              type: ChannelType.GuildText,
              position: ch.position,
              topic: ch.topic || undefined,
              nsfw: ch.nsfw || false,
              rateLimitPerUser: ch.rateLimitPerUser || 0
            });
          } else if (ch.type === 'voice') {
            await guild.channels.create({
              name: ch.name,
              type: ChannelType.GuildVoice,
              position: ch.position,
              bitrate: ch.bitrate || 64000,
              userLimit: ch.userLimit || 0
            });
          }
          createdChannels++;
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      } catch (e) {
        console.error(`❌ Ошибка канала ${ch.name}:`, e.message);
      }
    }
    
    return { 
      success: true, 
      categories: createdCategories, 
      channels: createdChannels,
      sourceGuildName: backupData.sourceGuildName,
      savedAt: backupData.savedAt
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// ========== ВОССТАНОВЛЕНИЕ ОДНОГО КАНАЛА ==========
async function restoreChannel(guild, channelData) {
  try {
    let parentId = null;
    if (channelData.parentName) {
      const parent = guild.channels.cache.find(c => c.type === ChannelType.GuildCategory && c.name === channelData.parentName);
      if (parent) parentId = parent.id;
    }
    
    if (channelData.type === 'text') {
      return await guild.channels.create({
        name: channelData.name, type: ChannelType.GuildText, parent: parentId,
        position: channelData.position, topic: channelData.topic || undefined,
        nsfw: channelData.nsfw || false, rateLimitPerUser: channelData.rateLimitPerUser || 0
      });
    } else if (channelData.type === 'voice') {
      return await guild.channels.create({
        name: channelData.name, type: ChannelType.GuildVoice, parent: parentId,
        position: channelData.position, bitrate: channelData.bitrate || 64000,
        userLimit: channelData.userLimit || 0
      });
    } else if (channelData.type === 'category') {
      return await guild.channels.create({
        name: channelData.name, type: ChannelType.GuildCategory, position: channelData.position
      });
    }
  } catch (error) {
    console.error(`❌ Ошибка восстановления ${channelData.name}:`, error);
    return null;
  }
}

// ========== СОЗДАНИЕ ПАНЕЛИ ОТПУСКОВ ==========
async function createLeavePanel(channel) {
  const messages = await channel.messages.fetch({ limit: 20 });
  const oldPanel = messages.find(m => m.author.id === client.user.id && m.embeds[0]?.title?.includes('ОТПУСК / ОТСУТСТВИЕ'));
  if (oldPanel) await oldPanel.delete().catch(() => {});
  
  const embed = new EmbedBuilder()
    .setTitle('🏖️ ОТПУСК / ОТСУТСТВИЕ')
    .setDescription(
      '**Выберите тип отсутствия:**\n\n' +
      '🏖️ **Отпуск** — укажите на сколько дней\n' +
      '🚶 **Отошёл** — укажите на сколько минут/часов\n\n' +
      'После заполнения вам будет выдана роль.'
    )
    .setColor(0x9B59B6)
    .setFooter({ text: 'Нажмите на кнопку ниже' });
  
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('leave_vacation').setLabel('Отпуск').setEmoji('🏖️').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('leave_away').setLabel('Отошёл').setEmoji('🚶').setStyle(ButtonStyle.Secondary)
  );
  
  const panelMessage = await channel.send({ embeds: [embed], components: [row] });
  
  return panelMessage;
}

// ========== АНТИ-СНОС ==========
client.on('channelDelete', async (channel) => {
  try {
    if (channel.type === ChannelType.DM || !channel.guild) return;
    
    const guild = channel.guild;
    const cfg = getConfig();
    
    if (guild.id !== cfg.guild1_id) return;
    
    if (isTicketChannel(channel)) {
      for (const [ticketId, ticket] of activeTickets) {
        if (ticket.channelId === channel.id) {
          clearTimeout(autoDeleteTimeouts.get(ticketId));
          activeTickets.delete(ticketId);
          autoDeleteTimeouts.delete(ticketId);
          break;
        }
      }
      return;
    }
    
    await new Promise(resolve => setTimeout(resolve, 1500));
    
    const auditLogs = await guild.fetchAuditLogs({ type: 12, limit: 10 });
    const deleteLog = auditLogs.entries.find(entry => 
      entry.target.id === channel.id && 
      Date.now() - entry.createdTimestamp < 10000
    );
    
    const executor = deleteLog?.executor;
    
    const channelData = {
      name: channel.name,
      type: channel.type === ChannelType.GuildText ? 'text' : 
            (channel.type === ChannelType.GuildVoice ? 'voice' : 'category'),
      parentName: channel.parent?.name || null,
      position: channel.position,
      topic: channel.topic || null,
      nsfw: channel.nsfw || false,
      rateLimitPerUser: channel.rateLimitPerUser || 0,
      bitrate: channel.bitrate || null,
      userLimit: channel.userLimit || null,
      deletedAt: new Date()
    };
    
    deletedChannels.set(channel.id, channelData);
    
    if (deletedChannels.size > 50) {
      const firstKey = deletedChannels.keys().next().value;
      deletedChannels.delete(firstKey);
    }
    
    if (executor && 
        executor.id !== guild.ownerId && 
        !executor.permissions.has(PermissionFlagsBits.Administrator) &&
        !executor.bot) {
      
      try {
        await executor.timeout(24 * 60 * 60 * 1000, 'Анти-снос: удаление канала без прав администратора');
        
        timedOutUsers.set(executor.id, {
          userId: executor.id,
          userTag: executor.tag,
          guildId: guild.id,
          timeoutEnd: Date.now() + 24 * 60 * 60 * 1000
        });
        
        const admins = guild.members.cache.filter(m => 
          m.permissions.has(PermissionFlagsBits.Administrator) && !m.user.bot
        );
        
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`remove_timeout_${executor.id}`)
            .setLabel('🔓 Снять таймаут')
            .setStyle(ButtonStyle.Success),
          new ButtonBuilder()
            .setCustomId(`restore_deleted_${channel.id}`)
            .setLabel('🔄 Восстановить канал')
            .setStyle(ButtonStyle.Primary)
        );
        
        const alertEmbed = new EmbedBuilder()
          .setTitle('🚨 АНТИ-СНОС: КАНАЛ УДАЛЁН!')
          .setColor(0xFF0000)
          .setDescription(
            `**Нарушитель:** ${executor.tag} (${executor.id})\n` +
            `**Удалённый канал:** ${channelData.name}\n` +
            `**Тип:** ${channelData.type}\n\n` +
            `**Наказание:** Таймаут 24 часа\n\n` +
            `Нажмите кнопку ниже чтобы снять таймаут или восстановить канал.`
          )
          .setTimestamp();
        
        for (const admin of admins.values()) {
          try {
            await admin.send({ embeds: [alertEmbed], components: [row] });
          } catch (e) {}
        }
        
        if (cfg.logChannelId_guild1) {
          const logChannel = await guild.channels.fetch(cfg.logChannelId_guild1).catch(() => null);
          if (logChannel) {
            const logEmbed = new EmbedBuilder()
              .setTitle('🚨 АНТИ-СНОС: ТАЙМАУТ ВЫДАН')
              .setColor(0xFF0000)
              .addFields(
                { name: '👤 Нарушитель', value: executor.tag, inline: true },
                { name: '🗑️ Канал', value: channelData.name, inline: true },
                { name: '⏰ Наказание', value: '24 часа', inline: true }
              )
              .setTimestamp();
            
            await logChannel.send({ embeds: [logEmbed] });
          }
        }
      } catch (error) {
        console.error(`❌ Ошибка выдачи таймаута:`, error);
      }
    }
    
  } catch (error) {
    console.error('❌ Ошибка в channelDelete:', error);
  }
});

// ========== ПРИВЕТСТВИЕ ==========
client.on('guildMemberAdd', async (member) => {
  try {
    const cfg = getConfig();
    
    if (member.guild.id === cfg.guild1_id && cfg.autoRoleId) {
      await member.roles.add(cfg.autoRoleId).catch(() => {});
    }
    
    try {
      const newInvites = await member.guild.invites.fetch();
      invites.set(member.guild.id, newInvites);
    } catch (error) {}
    
  } catch (error) {
    console.error('❌ Ошибка в guildMemberAdd:', error);
  }
});

// ========== ОТСЛЕЖИВАНИЕ ПРИГЛАШЕНИЙ ==========
client.on('inviteCreate', async (invite) => {
  const guildInvites = invites.get(invite.guild.id) || new Collection();
  guildInvites.set(invite.code, invite);
  invites.set(invite.guild.id, guildInvites);
});

client.on('inviteDelete', async (invite) => {
  const guildInvites = invites.get(invite.guild.id);
  if (guildInvites) {
    guildInvites.delete(invite.code);
    invites.set(invite.guild.id, guildInvites);
  }
});

// ========== ЗАПУСК БОТА ==========
client.once('ready', async () => {
  console.log(`✅ Бот ${client.user.tag} запущен!`);
  console.log(`🌍 ГЛОБАЛЬНЫЙ БЭКАП АКТИВЕН`);
  console.log(`📋 Серверов: ${client.guilds.cache.size}`);
  
  setInterval(() => {
    client.user.setActivity('ᴇᴜʀᴏᴘᴇᴀɴ ᴜɴɪᴏɴ', { type: 3 });
  }, 60000);
  
  client.user.setActivity('ᴇᴜʀᴏᴘᴇᴀɴ ᴜɴɪᴏɴ', { type: 3 });
  
  client.guilds.cache.forEach(async (guild) => {
    try {
      const guildInvites = await guild.invites.fetch();
      invites.set(guild.id, new Collection(guildInvites.map(invite => [invite.code, invite])));
    } catch (error) {}
  });
  
  const cfg = getConfig();
  const guild2 = client.guilds.cache.get(cfg.guild2_id);
  if (guild2) {
    await cleanExpiredWarns(guild2);
    
    const savedChannelId = leavePanels.get(guild2.id);
    if (savedChannelId) {
      const channel = await guild2.channels.fetch(savedChannelId).catch(() => null);
      if (channel) {
        await createLeavePanel(channel);
      }
    }
  }
  
  setInterval(async () => {
    const g2 = client.guilds.cache.get(cfg.guild2_id);
    if (g2) await cleanExpiredWarns(g2);
  }, 10 * 60 * 1000);
  
  try {
    await client.application.commands.set([
      // Сервер 1 (тикеты)
      { name: 'ticket', description: '[СЕРВЕР 1] Создать сообщение для подачи заявок' },
      { name: 'stats', description: '[СЕРВЕР 1] Показать статистику заявок за неделю' },
      { name: 'unbanall', description: '[СЕРВЕР 1] Разбанить всех забаненных участников' },
      { name: 'save_backup', description: '[СЕРВЕР 1] Сохранить структуру каналов в ГЛОБАЛЬНЫЙ бэкап' },
      { name: 'restore_backup', description: '[СЕРВЕР 1] Восстановить каналы из ГЛОБАЛЬНОГО бэкапа' },
      { name: 'backup_info', description: '[СЕРВЕР 1] Показать информацию о глобальном бэкапе' },
      { name: 'deleted_list', description: '[СЕРВЕР 1] Показать список недавно удалённых каналов' },
      
      // Сервер 2 (варны)
      { name: 'warn', description: '[СЕРВЕР 2] Выдать предупреждение пользователю',
        options: [
          { name: 'user', description: 'Пользователь', type: 6, required: true },
          { name: 'days', description: 'Срок в днях', type: 4, required: true },
          { name: 'reason', description: 'Причина', type: 3, required: true },
          { name: 'workoff', description: 'Отработка (необязательно)', type: 3, required: false }
        ]
      },
      { name: 'unwarn', description: '[СЕРВЕР 2] Снять все предупреждения с пользователя',
        options: [
          { name: 'user', description: 'Пользователь', type: 6, required: true }
        ]
      },
      { name: 'warnpanel', description: '[СЕРВЕР 2] Создать панель управления варнами' },
      { name: 'event', description: '[СЕРВЕР 2] Создать событие с кнопками подтверждения',
        options: [
          { name: 'date', description: 'Дата в формате ДД.ММ.ГГГГ', type: 3, required: true },
          { name: 'time', description: 'Время в формате ЧЧ:ММ (МСК)', type: 3, required: true },
          { name: 'description', description: 'Описание события', type: 3, required: true }
        ]
      },
      { name: 'leavepanel', description: '[СЕРВЕР 2] Создать панель отпусков/отсутствия',
        options: [
          { name: 'channel', description: 'Канал для панели (по умолч. текущий)', type: 7, required: false }
        ]
      },
      
      // Общие
      { name: 'ping', description: 'Проверить задержку бота' },
      { name: 'uptime', description: 'Показать время работы бота' },
      { name: 'send', description: 'Отправить сообщение от имени бота',
        options: [
          { name: 'channel', description: 'Канал для отправки', type: 7, required: true },
          { name: 'text', description: 'Текст сообщения', type: 3, required: false },
          { name: 'name', description: 'Имя отправителя', type: 3, required: false },
          { name: 'avatar', description: 'Ссылка на аватарку', type: 3, required: false }
        ]
      },
      { name: 'invites', description: 'Показать топ пригласивших' }
    ]);
    
    console.log('✅ Команды зарегистрированы!');
  } catch (error) {
    console.error('❌ Ошибка регистрации команд:', error);
  }
});

// ========== ОБРАБОТКА ВЗАИМОДЕЙСТВИЙ ==========
client.on('interactionCreate', async interaction => {
  const cfg = getConfig();
  const guild = interaction.guild;
  if (!guild) return;
  
  const guildId = guild.id;
  const member = interaction.member;
  
  const isGuild1 = guildId === cfg.guild1_id;
  const isGuild2 = guildId === cfg.guild2_id;
  
  const hasStaff = hasStaffPermission(member, guildId);
  const isAdmin = member.permissions.has(PermissionFlagsBits.Administrator);
  
  // ========== КОМАНДЫ СЕРВЕРА 1 ==========
  
  // /save_backup
  if (interaction.isCommand() && interaction.commandName === 'save_backup') {
    if (!isGuild1) return interaction.reply({ content: '❌ Эта команда работает только на СЕРВЕРЕ 1!', ephemeral: true });
    if (!isAdmin) return interaction.reply({ content: '❌ Только для админов!', ephemeral: true });
    
    await interaction.deferReply({ ephemeral: true });
    
    try {
      const backupData = await saveToGlobalBackup(guild);
      
      if (backupData) {
        const embed = new EmbedBuilder()
          .setTitle('🌍 ГЛОБАЛЬНЫЙ БЭКАП СОХРАНЁН')
          .setColor(0x00FF00)
          .setDescription(
            `**Сервер-источник:** ${backupData.sourceGuildName}\n` +
            `**Категорий:** ${backupData.categories.length}\n` +
            `**Каналов:** ${backupData.totalChannels}\n` +
            `**Сохранено:** ${new Date(backupData.savedAt).toLocaleString('ru-RU')}\n\n` +
            `✅ **Теперь на ЛЮБОМ сервере используйте:**\n` +
            `\`/restore_backup\` — чтобы создать эти каналы!`
          )
          .setTimestamp();
        
        await interaction.editReply({ embeds: [embed] });
      } else {
        await interaction.editReply({ content: '❌ Ошибка сохранения бэкапа!' });
      }
    } catch (error) {
      await interaction.editReply({ content: `❌ Ошибка: ${error.message}` });
    }
  }
  
  // /restore_backup
  if (interaction.isCommand() && interaction.commandName === 'restore_backup') {
    if (!isGuild1) return interaction.reply({ content: '❌ Эта команда работает только на СЕРВЕРЕ 1!', ephemeral: true });
    if (!isAdmin) return interaction.reply({ content: '❌ Только для админов!', ephemeral: true });
    
    const backupData = globalBackup.get('last_backup');
    
    if (!backupData) {
      return interaction.reply({ 
        content: '❌ Глобальный бэкап не создан!\n\nСначала на сервере-источнике используйте `/save_backup`', 
        ephemeral: true 
      });
    }
    
    await interaction.deferReply({ ephemeral: true });
    
    try {
      const result = await restoreFromGlobalBackup(guild);
      
      if (result.success) {
        const embed = new EmbedBuilder()
          .setTitle('✅ КАНАЛЫ ВОССТАНОВЛЕНЫ ИЗ ГЛОБАЛЬНОГО БЭКАПА')
          .setColor(0x00FF00)
          .setDescription(
            `**Сервер-источник:** ${result.sourceGuildName}\n` +
            `**Бэкап от:** ${new Date(result.savedAt).toLocaleString('ru-RU')}\n\n` +
            `**Категорий создано:** ${result.categories}\n` +
            `**Каналов создано:** ${result.channels}\n\n` +
            `⚠️ Существующие каналы пропущены.`
          )
          .setTimestamp();
        
        await interaction.editReply({ embeds: [embed] });
      } else {
        await interaction.editReply({ content: result.error });
      }
    } catch (error) {
      await interaction.editReply({ content: `❌ Ошибка: ${error.message}` });
    }
  }
  
  // /backup_info
  if (interaction.isCommand() && interaction.commandName === 'backup_info') {
    if (!isGuild1) return interaction.reply({ content: '❌ Эта команда работает только на СЕРВЕРЕ 1!', ephemeral: true });
    if (!isAdmin) return interaction.reply({ content: '❌ Только для админов!', ephemeral: true });
    
    const backupData = globalBackup.get('last_backup');
    
    if (!backupData) {
      return interaction.reply({ 
        content: '❌ Глобальный бэкап не создан!', 
        ephemeral: true 
      });
    }
    
    const embed = new EmbedBuilder()
      .setTitle('🌍 ИНФОРМАЦИЯ О ГЛОБАЛЬНОМ БЭКАПЕ')
      .setColor(0x3498DB)
      .setDescription(
        `**Сервер-источник:** ${backupData.sourceGuildName}\n` +
        `**ID сервера:** ${backupData.sourceGuildId}\n` +
        `**Сохранён:** ${new Date(backupData.savedAt).toLocaleString('ru-RU')}\n` +
        `**Категорий:** ${backupData.categories.length}\n` +
        `**Каналов всего:** ${backupData.totalChannels}`
      )
      .setTimestamp();
    
    await interaction.reply({ embeds: [embed], ephemeral: true });
  }
  
  // /deleted_list
  if (interaction.isCommand() && interaction.commandName === 'deleted_list') {
    if (!isGuild1) return interaction.reply({ content: '❌ Эта команда работает только на СЕРВЕРЕ 1!', ephemeral: true });
    if (!isAdmin) return interaction.reply({ content: '❌ Только для админов!', ephemeral: true });
    
    if (deletedChannels.size === 0) {
      return interaction.reply({ content: '📭 Нет удалённых каналов в памяти', ephemeral: true });
    }
    
    const channels = Array.from(deletedChannels.values());
    const list = channels.slice(0, 20).map((ch, i) => 
      `**${i + 1}.** ${ch.type === 'text' ? '💬' : ch.type === 'voice' ? '🔊' : '📁'} **${ch.name}** — ${new Date(ch.deletedAt).toLocaleTimeString('ru-RU')}`
    ).join('\n');
    
    const embed = new EmbedBuilder()
      .setTitle('🗑️ НЕДАВНО УДАЛЁННЫЕ КАНАЛЫ')
      .setColor(0xFFA500)
      .setDescription(list || 'Нет данных')
      .setFooter({ text: `Всего: ${deletedChannels.size} каналов` });
    
    await interaction.reply({ embeds: [embed], ephemeral: true });
  }
  
  // /unbanall
  if (interaction.isCommand() && interaction.commandName === 'unbanall') {
    if (!isGuild1) return interaction.reply({ content: '❌ Эта команда работает только на СЕРВЕРЕ 1!', ephemeral: true });
    if (!isAdmin) return interaction.reply({ content: '❌ Только для админов!', ephemeral: true });
    
    await interaction.deferReply({ ephemeral: true });
    
    try {
      const bans = await guild.bans.fetch();
      if (bans.size === 0) return interaction.editReply({ content: 'ℹ️ Нет забаненных участников.' });
      
      let unbannedCount = 0;
      for (const ban of bans.values()) {
        try {
          await guild.members.unban(ban.user.id);
          unbannedCount++;
        } catch (error) {}
      }
      
      const embed = new EmbedBuilder()
        .setTitle('🔓 РАЗБАН ВСЕХ')
        .setColor(0x00FF00)
        .setDescription(`**Разбанено:** ${unbannedCount}`);
      
      await interaction.editReply({ embeds: [embed] });
    } catch (error) {
      await interaction.editReply({ content: `❌ Ошибка: ${error.message}` });
    }
  }
  
  // /stats
  if (interaction.isCommand() && interaction.commandName === 'stats') {
    if (!isGuild1) return interaction.reply({ content: '❌ Эта команда работает только на СЕРВЕРЕ 1!', ephemeral: true });
    if (!hasStaff) return interaction.reply({ content: '❌ Нет прав!', ephemeral: true });
    
    const sortedStaff = [...staffStats.entries()]
      .sort((a, b) => b[1].accepted - a[1].accepted)
      .slice(0, 10);
    
    let staffList = sortedStaff.length > 0 
      ? sortedStaff.map(([id, data]) => `<@${id}> — **${data.accepted}**`).join('\n')
      : 'Нет данных';
    
    const embed = new EmbedBuilder()
      .setTitle('📊 СТАТИСТИКА ЗА НЕДЕЛЮ')
      .setColor(0x3498DB)
      .addFields(
        { name: '✅ Принято', value: `${stats.weekAccepted}`, inline: true },
        { name: '❌ Отклонено', value: `${stats.weekDenied}`, inline: true },
        { name: '🤖 Авто-отклонено', value: `${stats.autoDenied || 0}`, inline: true },
        { name: '🔧 Статус набора', value: ticketStatus ? '🟢 Открыт' : '🔴 Закрыт', inline: true },
        { name: '👑 Топ стаффа', value: staffList, inline: false }
      )
      .setTimestamp();
    
    await interaction.reply({ embeds: [embed], ephemeral: true });
  }
  
  // /ticket
  if (interaction.isCommand() && interaction.commandName === 'ticket') {
    if (!isGuild1) return interaction.reply({ content: '❌ Эта команда работает только на СЕРВЕРЕ 1!', ephemeral: true });
    if (!isAdmin) return interaction.reply({ content: '❌ Нет прав!', ephemeral: true });
    
    await createTicketMessage(interaction.channel);
    await interaction.reply({ content: '✅ Сообщение для подачи заявок создано!', ephemeral: true });
  }
  
  // ========== КОМАНДЫ СЕРВЕРА 2 ==========
  
  // /warnpanel
  if (interaction.isCommand() && interaction.commandName === 'warnpanel') {
    if (!isGuild2) return interaction.reply({ content: '❌ Эта команда работает только на СЕРВЕРЕ 2!', ephemeral: true });
    if (!hasStaff) return interaction.reply({ content: '❌ У вас нет прав!', ephemeral: true });
    
    const embed = new EmbedBuilder()
      .setTitle('⚠️ ПАНЕЛЬ УПРАВЛЕНИЯ ВАРНАМИ')
      .setDescription('**Выберите действие:**')
      .setColor(0xFFA500);
    
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('panel_warn').setLabel('Выдать варн').setEmoji('⚠️').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('panel_unwarn').setLabel('Снять варны').setEmoji('✅').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('panel_appeal').setLabel('Обжалование').setEmoji('📝').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('panel_workoff').setLabel('Отработка').setEmoji('✅').setStyle(ButtonStyle.Success)
    );
    
    await interaction.channel.send({ embeds: [embed], components: [row] });
    await interaction.reply({ content: '✅ Панель создана!', ephemeral: true });
  }
  
  // /leavepanel
  if (interaction.isCommand() && interaction.commandName === 'leavepanel') {
    if (!isGuild2) return interaction.reply({ content: '❌ Эта команда работает только на СЕРВЕРЕ 2!', ephemeral: true });
    if (!hasStaff) return interaction.reply({ content: '❌ У вас нет прав!', ephemeral: true });
    
    const targetChannel = interaction.options.getChannel('channel') || interaction.channel;
    
    if (!targetChannel.isTextBased()) {
      return interaction.reply({ content: '❌ Канал должен быть текстовым!', ephemeral: true });
    }
    
    await createLeavePanel(targetChannel);
    leavePanels.set(guild.id, targetChannel.id);
    
    await interaction.reply({ content: `✅ Панель создана в ${targetChannel}!`, ephemeral: true });
  }
  
  // /event
  if (interaction.isCommand() && interaction.commandName === 'event') {
    if (!isGuild2) return interaction.reply({ content: '❌ Эта команда работает только на СЕРВЕРЕ 2!', ephemeral: true });
    
    const dateStr = interaction.options.getString('date');
    const timeStr = interaction.options.getString('time');
    const description = interaction.options.getString('description');
    
    const dateMatch = dateStr.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
    if (!dateMatch) {
      return interaction.reply({ content: '❌ Неверный формат даты! Используйте ДД.ММ.ГГГГ', ephemeral: true });
    }
    
    const timeMatch = timeStr.match(/^(\d{1,2}):(\d{2})$/);
    if (!timeMatch) {
      return interaction.reply({ content: '❌ Неверный формат времени! Используйте ЧЧ:ММ', ephemeral: true });
    }
    
    const day = parseInt(dateMatch[1]);
    const month = parseInt(dateMatch[2]);
    const year = parseInt(dateMatch[3]);
    const hours = parseInt(timeMatch[1]);
    const minutes = parseInt(timeMatch[2]);
    
    if (day < 1 || day > 31 || month < 1 || month > 12) {
      return interaction.reply({ content: '❌ Неверная дата!', ephemeral: true });
    }
    
    if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
      return interaction.reply({ content: '❌ Неверное время!', ephemeral: true });
    }
    
    const eventTime = new Date(Date.UTC(year, month - 1, day, hours - 3, minutes, 0));
    
    if (eventTime < new Date()) {
      return interaction.reply({ content: '❌ Нельзя создать событие в прошлом!', ephemeral: true });
    }
    
    const reminderTime = new Date(eventTime.getTime() - 15 * 60 * 1000);
    
    await interaction.reply({ content: '✅ Событие создается...', ephemeral: true });
    
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('event_accept').setLabel('Приду').setEmoji('✅').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('event_decline').setLabel('Не приду').setEmoji('❌').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('event_maybe').setLabel('Возможно').setEmoji('❓').setStyle(ButtonStyle.Secondary)
    );
    
    const embed = new EmbedBuilder()
      .setTitle('📅 СОБЫТИЕ')
      .setDescription(`### ${description}`)
      .addFields(
        { name: '📅 Дата', value: dateStr, inline: true },
        { name: '🕐 Время', value: `${timeStr} МСК`, inline: true },
        { name: '🔔 Напоминание', value: 'За 15 минут', inline: true },
        { name: '✅ Придут (0)', value: '―', inline: true },
        { name: '❌ Не придут (0)', value: '―', inline: true },
        { name: '❓ Возможно (0)', value: '―', inline: true }
      )
      .setColor(0x3498DB);
    
    const message = await interaction.channel.send({ embeds: [embed], components: [row] });
    
    await interaction.editReply({ content: `✅ **Событие создано!** ${message.url}`, ephemeral: true });
    
    const eventId = message.id;
    events.set(eventId, {
      messageId: message.id,
      channelId: interaction.channel.id,
      guildId: guild.id,
      description: description,
      dateStr: dateStr,
      timeStr: timeStr,
      eventTime: eventTime.getTime(),
      reminderTime: reminderTime.getTime(),
      accept: new Set(),
      decline: new Set(),
      maybe: new Set(),
      embed: embed
    });
    
    const timeUntilReminder = reminderTime.getTime() - Date.now();
    if (timeUntilReminder > 0) {
      setTimeout(async () => {
        const event = events.get(eventId);
        if (!event) return;
        
        const channel = await client.channels.fetch(event.channelId).catch(() => null);
        if (!channel) return;
        
        const usersToPing = [...event.accept, ...event.maybe];
        
        if (usersToPing.length > 0) {
          const mentions = usersToPing.map(id => `<@${id}>`).join(' ');
          await channel.send({
            content: `${mentions}\n🔔 **Напоминание!** Через 15 минут: **${event.description}**`
          });
        } else {
          await channel.send({
            content: `🔔 **Напоминание!** Через 15 минут: **${event.description}**\nПока никто не подтвердил участие.`
          });
        }
        
        setTimeout(() => events.delete(eventId), 60 * 60 * 1000);
      }, timeUntilReminder);
    }
  }
  
  // /warn
  if (interaction.isCommand() && interaction.commandName === 'warn') {
    if (!isGuild2) return interaction.reply({ content: '❌ Эта команда работает только на СЕРВЕРЕ 2!', ephemeral: true });
    if (!hasStaff) return interaction.reply({ content: '❌ У вас нет прав!', ephemeral: true });
    
    const user = interaction.options.getUser('user');
    const days = interaction.options.getInteger('days');
    const reason = interaction.options.getString('reason');
    const workoff = interaction.options.getString('workoff') || null;
    
    if (days <= 0) return interaction.reply({ content: '❌ Срок должен быть положительным числом!', ephemeral: true });
    
    await interaction.deferReply({ ephemeral: true });
    
    try {
      const targetMember = await guild.members.fetch(user.id).catch(() => null);
      if (!targetMember) return interaction.editReply('❌ Пользователь не найден!');
      
      const today = new Date();
      const dateStr = `${today.getDate().toString().padStart(2, '0')}.${(today.getMonth()+1).toString().padStart(2, '0')}.${today.getFullYear()}`;
      
      let roleName = `⚠️ Warn (${dateStr}) [${days}д]`;
      if (reason) roleName += ` | 📝 ${reason}`;
      if (workoff) roleName += ` | 🔄 ${workoff}`;
      
      let warnRole = guild.roles.cache.find(r => r.name === roleName);
      if (!warnRole) {
        warnRole = await guild.roles.create({ name: roleName, color: 0xFFA500, reason: `Варн для ${targetMember.user.tag}` });
      }
      
      await targetMember.roles.add(warnRole);
      
      const embed = new EmbedBuilder().setTitle('⚠️ Предупреждение выдано').setColor(0xFFA500)
        .setDescription(`**Пользователь:** <@${targetMember.id}>\n**Модератор:** <@${interaction.user.id}>\n**Причина:** ${reason}\n**Срок:** ${days} дней`);
      
      await interaction.editReply({ embeds: [embed] });
      
      const logEmbed = new EmbedBuilder().setTitle('⚠️ Выдан варн').setColor(0xFFA500).addFields(
        { name: '👤 Пользователь', value: `<@${targetMember.id}> (${targetMember.user.tag})`, inline: true },
        { name: '👮 Модератор', value: `<@${interaction.user.id}> (${interaction.user.tag})`, inline: true },
        { name: '⏰ Срок', value: `${days} дней`, inline: true },
        { name: '📝 Причина', value: reason, inline: false }
      );
      
      if (workoff) logEmbed.addFields({ name: '🔄 Отработка', value: workoff, inline: false });
      
      await sendLog(guild, logEmbed);
      
      try {
        await targetMember.send({ embeds: [new EmbedBuilder().setTitle('⚠️ Вы получили предупреждение').setColor(0xFFA500).setDescription(`**Причина:** ${reason}\n**Срок:** ${days} дней`)] });
      } catch (error) {}
      
    } catch (error) {
      console.error('❌ Ошибка:', error);
      await interaction.editReply('❌ Произошла ошибка!');
    }
  }
  
  // /unwarn
  if (interaction.isCommand() && interaction.commandName === 'unwarn') {
    if (!isGuild2) return interaction.reply({ content: '❌ Эта команда работает только на СЕРВЕРЕ 2!', ephemeral: true });
    if (!hasStaff) return interaction.reply({ content: '❌ У вас нет прав!', ephemeral: true });
    
    const user = interaction.options.getUser('user');
    
    await interaction.deferReply({ ephemeral: true });
    
    try {
      const targetMember = await guild.members.fetch(user.id).catch(() => null);
      if (!targetMember) return interaction.editReply('❌ Пользователь не найден!');
      
      const removedCount = await removeAllWarns(targetMember);
      
      if (removedCount === 0) {
        return interaction.editReply(`ℹ️ У ${targetMember.user.tag} нет активных предупреждений.`);
      }
      
      const embed = new EmbedBuilder().setTitle('✅ Предупреждения сняты').setColor(0x00FF00)
        .setDescription(`**Пользователь:** <@${targetMember.id}>\n**Модератор:** <@${interaction.user.id}>\n**Снято варнов:** ${removedCount}`);
      
      await interaction.editReply({ embeds: [embed] });
      
      const logEmbed = new EmbedBuilder().setTitle('✅ Варны сняты').setColor(0x00FF00).addFields(
        { name: '👤 Пользователь', value: `<@${targetMember.id}> (${targetMember.user.tag})`, inline: true },
        { name: '👮 Модератор', value: `<@${interaction.user.id}> (${interaction.user.tag})`, inline: true },
        { name: '📊 Количество', value: `${removedCount}`, inline: true }
      );
      
      await sendLog(guild, logEmbed);
      
    } catch (error) {
      console.error('❌ Ошибка:', error);
      await interaction.editReply('❌ Произошла ошибка!');
    }
  }
  
  // ========== ОБЩИЕ КОМАНДЫ ==========
  
  // /ping
  if (interaction.isCommand() && interaction.commandName === 'ping') {
    const backup = globalBackup.get('last_backup');
    const sent = await interaction.reply({ content: '🏓 Пинг...', fetchReply: true, ephemeral: true });
    await interaction.editReply({ 
      content: `🏓 Понг! **${sent.createdTimestamp - interaction.createdTimestamp}ms** | API: **${client.ws.ping}ms**\n` +
               `🌍 Глобальный бэкап: ${backup ? `${backup.sourceGuildName} (${backup.totalChannels} каналов)` : 'не создан'}`
    });
  }
  
  // /uptime
  if (interaction.isCommand() && interaction.commandName === 'uptime') {
    const embed = new EmbedBuilder()
      .setTitle('⏰ ВРЕМЯ РАБОТЫ БОТА')
      .setColor(0x3498DB)
      .setDescription(`**${getUptime()}**`)
      .addFields({ name: '📅 Запущен', value: `<t:${Math.floor(startTime / 1000)}:F>`, inline: true });
    
    await interaction.reply({ embeds: [embed] });
  }
  
  // /invites
  if (interaction.isCommand() && interaction.commandName === 'invites') {
    await interaction.deferReply({ ephemeral: true });
    
    try {
      const guildInvites = await guild.invites.fetch();
      const inviterStats = new Collection();
      
      for (const invite of guildInvites.values()) {
        if (invite.inviter) {
          const stats = inviterStats.get(invite.inviter.id) || { user: invite.inviter, uses: 0 };
          stats.uses += invite.uses || 0;
          inviterStats.set(invite.inviter.id, stats);
        }
      }
      
      const sorted = Array.from(inviterStats.values())
        .sort((a, b) => b.uses - a.uses)
        .slice(0, 15);
      
      if (sorted.length === 0) return interaction.editReply({ content: '📭 Нет данных' });
      
      const list = sorted.map((stat, i) => `**${i + 1}.** ${stat.user} — **${stat.uses}** приглашений`).join('\n');
      
      const embed = new EmbedBuilder()
        .setTitle('📨 ТОП ПРИГЛАСИВШИХ')
        .setColor(0x9B59B6)
        .setDescription(list)
        .setTimestamp();
      
      await interaction.editReply({ embeds: [embed] });
    } catch (error) {
      await interaction.editReply({ content: '❌ Ошибка!' });
    }
  }
  
  // /send
  if (interaction.isCommand() && interaction.commandName === 'send') {
    if (!hasStaff) return interaction.reply({ content: '❌ У вас нет прав!', ephemeral: true });
    
    const channel = interaction.options.getChannel('channel');
    const text = interaction.options.getString('text') || '';
    const customName = interaction.options.getString('name') || 'European Union';
    const avatarUrl = interaction.options.getString('avatar') || client.user.displayAvatarURL();
    
    if (!channel.isTextBased()) {
      return interaction.reply({ content: '❌ Канал должен быть текстовым!', ephemeral: true });
    }
    
    const sendData = {
      channelId: channel.id,
      text: text,
      customName: customName,
      avatarUrl: avatarUrl
    };
    
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`send_photo_${interaction.user.id}`).setLabel('Прикрепить фото').setEmoji('📷').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`send_now_${interaction.user.id}`).setLabel('Отправить сейчас').setEmoji('📤').setStyle(ButtonStyle.Success)
    );
    
    pendingSends.set(interaction.user.id, sendData);
    
    await interaction.reply({
      content: `📤 **Отправка в ${channel}**\nИмя: **${customName}**\n\n**Превью:**\n${text || '(без текста)'}\n\nНажмите кнопку ниже:`,
      components: [row],
      ephemeral: true
    });
  }
  
  // ========== КНОПКИ ==========
  if (interaction.isButton()) {
    const id = interaction.customId;
    
    // Кнопки сервера 1
    if (isGuild1) {
      
      if (id.startsWith('restore_deleted_')) {
        if (!isAdmin) return interaction.reply({ content: '❌ Только для админов!', ephemeral: true });
        
        const channelId = id.replace('restore_deleted_', '');
        const channelData = deletedChannels.get(channelId);
        
        if (!channelData) {
          return interaction.reply({ content: '❌ Данные канала не найдены!', ephemeral: true });
        }
        
        await interaction.deferReply({ ephemeral: true });
        
        try {
          const restored = await restoreChannel(guild, channelData);
          
          if (restored) {
            deletedChannels.delete(channelId);
            
            const embed = new EmbedBuilder()
              .setTitle('✅ КАНАЛ ВОССТАНОВЛЕН')
              .setColor(0x00FF00)
              .setDescription(`Канал **${channelData.name}** успешно восстановлен!`);
            
            await interaction.editReply({ embeds: [embed] });
          } else {
            await interaction.editReply({ content: '❌ Не удалось восстановить канал!' });
          }
        } catch (error) {
          await interaction.editReply({ content: `❌ Ошибка: ${error.message}` });
        }
      }
      
      if (id.startsWith('remove_timeout_')) {
        if (!isAdmin) return interaction.reply({ content: '❌ Только для админов!', ephemeral: true });
        
        const targetUserId = id.replace('remove_timeout_', '');
        
        try {
          const targetMember = await guild.members.fetch(targetUserId).catch(() => null);
          
          if (!targetMember) return interaction.reply({ content: '❌ Участник не найден!', ephemeral: true });
          if (!targetMember.communicationDisabledUntil) return interaction.reply({ content: '❌ Нет таймаута!', ephemeral: true });
          
          await targetMember.timeout(null, `Снят админом ${interaction.user.tag}`);
          timedOutUsers.delete(targetUserId);
          
          const embed = new EmbedBuilder()
            .setTitle('✅ ТАЙМАУТ СНЯТ')
            .setColor(0x00FF00)
            .setDescription(`Таймаут с **${targetMember.user.tag}** снят.`);
          
          await interaction.update({ embeds: [embed], components: [] });
        } catch (error) {
          await interaction.reply({ content: `❌ Ошибка: ${error.message}`, ephemeral: true });
        }
      }
      
      if (id === 'toggle_ticket') {
        if (!hasStaff) return interaction.reply({ content: '❌ Нет прав!', ephemeral: true });
        
        ticketStatus = !ticketStatus;
        
        const embed = EmbedBuilder.from(interaction.message.embeds[0]).setDescription(
          interaction.message.embeds[0].description.replace(/Статус набора:.*/, `**Статус набора:** ${ticketStatus ? '🟢 Открыт' : '🔴 Закрыт'}`)
        );
        
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('create_ticket').setLabel('📝 Подать заявку').setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId('toggle_ticket').setEmoji(ticketStatus ? '🟢' : '🔴').setStyle(ButtonStyle.Secondary)
        );
        
        await interaction.update({ embeds: [embed], components: [row] });
      }
      
      if (id === 'create_ticket') {
        if (!ticketStatus) return interaction.reply({ content: '❌ Набор закрыт!', ephemeral: true });
        
        const modal = new ModalBuilder().setCustomId('app_ticket').setTitle('Заявка в European Union');
        
        modal.addComponents(
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('name').setLabel('Имя').setPlaceholder('Артём').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(50)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('age').setLabel('Возраст (цифры)').setPlaceholder('15').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(3)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('steam').setLabel('Steam ссылка').setPlaceholder('https://steamcommunity.com/...').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(200)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('hours').setLabel('Часы (цифры)').setPlaceholder('3500').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(10)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('role').setLabel('Роль').setPlaceholder('Строитель, ПвПшник...').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(100))
        );
        
        await interaction.showModal(modal);
      }
      
      if (id.startsWith('close_')) {
        const channelId = id.split('_')[1];
        if (!hasStaff) return interaction.reply({ content: '❌ Нет прав!', ephemeral: true });
        
        await interaction.reply({ content: '🔒 Закрываю...', ephemeral: true });
        const channel = await guild.channels.fetch(channelId).catch(() => null);
        
        for (const [tid, t] of activeTickets) {
          if (t.channelId === channelId) {
            clearTimeout(autoDeleteTimeouts.get(tid));
            activeTickets.delete(tid);
            break;
          }
        }
        
        setTimeout(() => channel?.delete().catch(() => {}), 2000);
      }
      
      if (id.startsWith('accept_')) {
        const [_, userId] = id.split('_');
        if (!hasStaff) return interaction.reply({ content: '❌ Нет прав!', ephemeral: true });
        
        const ticketId = `${userId}_ticket`;
        clearTimeout(autoDeleteTimeouts.get(ticketId));
        
        stats.accepted++;
        stats.weekAccepted++;
        
        const staffId = interaction.user.id;
        if (!staffStats.has(staffId)) staffStats.set(staffId, { accepted: 0, tag: interaction.user.tag });
        staffStats.get(staffId).accepted++;
        
        await updateStaffRole(guild, staffId, staffStats.get(staffId).accepted);
        
        // Выдача роли участника
        if (cfg.memberRoleId) {
          await guild.members.fetch(userId).then(m => m.roles.add(cfg.memberRoleId)).catch(() => {});
        }
        
        await interaction.update({ embeds: [EmbedBuilder.from(interaction.message.embeds[0]).setColor(0x00FF00)], components: [] });
        await interaction.channel.send(`<@${userId}> 🎉 Заявка принята! Роль выдана.`);
        
        activeTickets.delete(ticketId);
        
        // Удаляем канал сразу
        setTimeout(async () => {
          try {
            await interaction.channel.delete();
          } catch (error) {}
        }, 2000);
      }
      
      if (id.startsWith('consider_')) {
        const [_, userId] = id.split('_');
        if (!hasStaff) return interaction.reply({ content: '❌ Нет прав!', ephemeral: true });
        
        await interaction.update({ embeds: [EmbedBuilder.from(interaction.message.embeds[0]).setColor(0xFFA500)], components: interaction.message.components });
        await interaction.channel.send(`<@${userId}> ⏳ Заявка на рассмотрении.`);
      }
      
      if (id.startsWith('call_')) {
        const [_, userId] = id.split('_');
        if (!hasStaff) return interaction.reply({ content: '❌ Нет прав!', ephemeral: true });
        
        await interaction.update({ embeds: [EmbedBuilder.from(interaction.message.embeds[0]).setColor(0x808080)], components: interaction.message.components });
        const vc = interaction.member.voice.channel;
        const invite = vc ? await vc.createInvite({ maxAge: 86400, maxUses: 1 }).catch(() => null) : null;
        await interaction.channel.send(`<@${userId}> 📞 Обзвон!${invite ? `\n🔊 ${invite.url}` : ''}`);
      }
      
      if (id.startsWith('deny_')) {
        const [_, userId] = id.split('_');
        if (!hasStaff) return interaction.reply({ content: '❌ Нет прав!', ephemeral: true });
        
        const modal = new ModalBuilder()
          .setCustomId(`deny_reason_${userId}_${interaction.channel.id}`)
          .setTitle('❌ Причина отклонения');
        
        const reasonInput = new TextInputBuilder()
          .setCustomId('reason')
          .setLabel('Укажите причину')
          .setPlaceholder('Например: Недостаточно часов...')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(500);
        
        modal.addComponents(new ActionRowBuilder().addComponents(reasonInput));
        await interaction.showModal(modal);
      }
    }
    
    // Кнопки сервера 2
    if (isGuild2) {
      
      if (id === 'leave_vacation' || id === 'leave_away') {
        const emoji = id === 'leave_vacation' ? '🏖️' : '🚶';
        
        const modal = new ModalBuilder()
          .setCustomId(`leave_modal_${id}`)
          .setTitle(`${emoji} ${id === 'leave_vacation' ? 'Отпуск' : 'Отошёл'}`);
        
        const timeLabel = id === 'leave_vacation' ? 'На сколько дней?' : 'На сколько минут/часов?';
        const timePlaceholder = id === 'leave_vacation' ? 'Например: 7' : 'Например: 30 (минут) или 2 (часа)';
        
        const timeInput = new TextInputBuilder()
          .setCustomId('time')
          .setLabel(timeLabel)
          .setPlaceholder(timePlaceholder)
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(4);
        
        const reasonInput = new TextInputBuilder()
          .setCustomId('reason')
          .setLabel('Причина (необязательно)')
          .setPlaceholder(id === 'leave_vacation' ? 'Уезжаю в отпуск...' : 'Отошёл по делам...')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(false)
          .setMaxLength(200);
        
        if (id === 'leave_away') {
          const unitInput = new TextInputBuilder()
            .setCustomId('unit')
            .setLabel('Единица: минуты или часы? (мин/час)')
            .setPlaceholder('мин или час')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(4);
          
          modal.addComponents(
            new ActionRowBuilder().addComponents(timeInput),
            new ActionRowBuilder().addComponents(unitInput),
            new ActionRowBuilder().addComponents(reasonInput)
          );
        } else {
          modal.addComponents(
            new ActionRowBuilder().addComponents(timeInput),
            new ActionRowBuilder().addComponents(reasonInput)
          );
        }
        
        await interaction.showModal(modal);
      }
      
      if (id === 'event_accept' || id === 'event_decline' || id === 'event_maybe') {
        const messageId = interaction.message.id;
        const event = events.get(messageId);
        
        if (!event) {
          return interaction.reply({ content: '❌ Это событие уже неактивно!', ephemeral: true });
        }
        
        const userId = interaction.user.id;
        
        event.accept.delete(userId);
        event.decline.delete(userId);
        event.maybe.delete(userId);
        
        if (id === 'event_accept') {
          event.accept.add(userId);
        } else if (id === 'event_decline') {
          event.decline.add(userId);
        } else if (id === 'event_maybe') {
          event.maybe.add(userId);
        }
        
        const acceptList = event.accept.size > 0 ? [...event.accept].map(id => `<@${id}>`).join('\n') : '―';
        const declineList = event.decline.size > 0 ? [...event.decline].map(id => `<@${id}>`).join('\n') : '―';
        const maybeList = event.maybe.size > 0 ? [...event.maybe].map(id => `<@${id}>`).join('\n') : '―';
        
        const updatedEmbed = EmbedBuilder.from(interaction.message.embeds[0])
          .setFields(
            { name: '📅 Дата', value: event.dateStr, inline: true },
            { name: '🕐 Время', value: `${event.timeStr} МСК`, inline: true },
            { name: '🔔 Напоминание', value: 'За 15 минут', inline: true },
            { name: `✅ Придут (${event.accept.size})`, value: acceptList, inline: true },
            { name: `❌ Не придут (${event.decline.size})`, value: declineList, inline: true },
            { name: `❓ Возможно (${event.maybe.size})`, value: maybeList, inline: true }
          );
        
        await interaction.update({ embeds: [updatedEmbed] });
        
        event.embed = updatedEmbed;
        events.set(messageId, event);
        return;
      }
      
      if (id === 'panel_warn') {
        if (!hasStaff) return interaction.reply({ content: '❌ Нет прав!', ephemeral: true });
        
        const modal = new ModalBuilder().setCustomId('warn_modal').setTitle('⚠️ Выдать предупреждение');
        
        const userInput = new TextInputBuilder().setCustomId('user').setLabel('ID пользователя или @упоминание').setPlaceholder('Например: 1492902233354797329').setStyle(TextInputStyle.Short).setRequired(true);
        const daysInput = new TextInputBuilder().setCustomId('days').setLabel('Срок в днях').setPlaceholder('7').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(4);
        const reasonInput = new TextInputBuilder().setCustomId('reason').setLabel('Причина').setPlaceholder('Нарушение правил...').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(500);
        const workoffInput = new TextInputBuilder().setCustomId('workoff').setLabel('Отработка (необязательно)').setPlaceholder('Например: Принести 1000 серы').setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(200);
        
        modal.addComponents(
          new ActionRowBuilder().addComponents(userInput),
          new ActionRowBuilder().addComponents(daysInput),
          new ActionRowBuilder().addComponents(reasonInput),
          new ActionRowBuilder().addComponents(workoffInput)
        );
        
        await interaction.showModal(modal);
      }
      
      if (id === 'panel_unwarn') {
        if (!hasStaff) return interaction.reply({ content: '❌ Нет прав!', ephemeral: true });
        
        const modal = new ModalBuilder().setCustomId('unwarn_modal').setTitle('✅ Снять предупреждения');
        const userInput = new TextInputBuilder().setCustomId('user').setLabel('ID пользователя или @упоминание').setPlaceholder('Например: 1492902233354797329').setStyle(TextInputStyle.Short).setRequired(true);
        
        modal.addComponents(new ActionRowBuilder().addComponents(userInput));
        await interaction.showModal(modal);
      }
      
      if (id === 'panel_appeal') {
        const warnRoles = interaction.member.roles.cache.filter(r => r.name.startsWith('⚠️ Warn ('));
        
        if (warnRoles.size === 0) {
          return interaction.reply({ content: '❌ У вас нет активных предупреждений!', ephemeral: true });
        }
        
        const modal = new ModalBuilder().setCustomId('appeal_modal').setTitle('📝 Обжалование варна');
        const reasonInput = new TextInputBuilder().setCustomId('reason').setLabel('Почему варн несправедлив?').setPlaceholder('Опишите вашу ситуацию...').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(500);
        
        modal.addComponents(new ActionRowBuilder().addComponents(reasonInput));
        await interaction.showModal(modal);
      }
      
      if (id === 'panel_workoff') {
        const warnRoles = interaction.member.roles.cache.filter(r => r.name.startsWith('⚠️ Warn ('));
        
        if (warnRoles.size === 0) {
          return interaction.reply({ content: '❌ У вас нет активных предупреждений!', ephemeral: true });
        }
        
        const modal = new ModalBuilder().setCustomId('workoff_modal').setTitle('✅ Отработка варна');
        const reasonInput = new TextInputBuilder().setCustomId('reason').setLabel('Что вы сделали для отработки?').setPlaceholder('Опишите, что выполнено...').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(500);
        
        modal.addComponents(new ActionRowBuilder().addComponents(reasonInput));
        await interaction.showModal(modal);
      }
      
      if (id.startsWith('remove_warn_')) {
        const userId = id.split('_')[2];
        
        if (!hasStaff) return interaction.reply({ content: '❌ Нет прав!', ephemeral: true });
        
        await interaction.deferReply({ ephemeral: true });
        
        try {
          const targetMember = await guild.members.fetch(userId).catch(() => null);
          if (!targetMember) return interaction.editReply('❌ Пользователь не найден!');
          
          const removedCount = await removeAllWarns(targetMember);
          
          if (removedCount === 0) {
            return interaction.editReply(`ℹ️ У ${targetMember.user.tag} нет активных предупреждений.`);
          }
          
          const originalEmbed = interaction.message.embeds[0];
          const newEmbed = EmbedBuilder.from(originalEmbed)
            .setColor(0x00FF00)
            .setFooter({ text: `✅ Варны сняты модератором ${interaction.user.tag}` });
          
          await interaction.message.edit({ embeds: [newEmbed], components: [] });
          
          await interaction.editReply({ content: `✅ Снято ${removedCount} варнов с ${targetMember.user.tag}!`, ephemeral: true });
          await interaction.channel.send(`✅ **Варны сняты!** Модератор: <@${interaction.user.id}>`);
          
          const logEmbed = new EmbedBuilder().setTitle('✅ Варны сняты').setColor(0x00FF00).addFields(
            { name: '👤 Пользователь', value: `<@${targetMember.id}> (${targetMember.user.tag})`, inline: true },
            { name: '👮 Модератор', value: `<@${interaction.user.id}> (${interaction.user.tag})`, inline: true },
            { name: '📊 Количество', value: `${removedCount}`, inline: true }
          );
          
          await sendLog(guild, logEmbed);
          
          setTimeout(() => interaction.channel.delete().catch(() => {}), 5000);
          
        } catch (error) {
          console.error('❌ Ошибка:', error);
          await interaction.editReply('❌ Произошла ошибка!');
        }
      }
      
      if (id.startsWith('close_ticket_')) {
        if (!hasStaff) return interaction.reply({ content: '❌ Нет прав!', ephemeral: true });
        
        await interaction.reply({ content: '🔒 Закрываю...', ephemeral: true });
        setTimeout(() => interaction.channel.delete().catch(() => {}), 2000);
      }
    }
    
    // Кнопки /send (общие)
    if (id.startsWith('send_photo_')) {
      const userId = id.replace('send_photo_', '');
      if (interaction.user.id !== userId) {
        return interaction.reply({ content: '❌ Это не ваша команда!', ephemeral: true });
      }
      
      const sendData = pendingSends.get(userId);
      if (!sendData) {
        return interaction.reply({ content: '❌ Данные не найдены!', ephemeral: true });
      }
      
      const modal = new ModalBuilder().setCustomId(`send_modal_${userId}`).setTitle('📷 Прикрепить фото');
      const photoInput = new TextInputBuilder().setCustomId('photo_url').setLabel('Ссылка на фото').setPlaceholder('https://i.imgur.com/...').setStyle(TextInputStyle.Paragraph).setRequired(true);
      
      modal.addComponents(new ActionRowBuilder().addComponents(photoInput));
      
      await interaction.showModal(modal);
    }
    
    if (id.startsWith('send_now_')) {
      const userId = id.replace('send_now_', '');
      if (interaction.user.id !== userId) {
        return interaction.reply({ content: '❌ Это не ваша команда!', ephemeral: true });
      }
      
      const sendData = pendingSends.get(userId);
      if (!sendData) {
        return interaction.reply({ content: '❌ Данные не найдены!', ephemeral: true });
      }
      
      await interaction.deferUpdate();
      
      try {
        const channel = await client.channels.fetch(sendData.channelId);
        
        const webhook = await channel.createWebhook({
          name: sendData.customName,
          avatar: sendData.avatarUrl
        });
        
        const embed = new EmbedBuilder()
          .setColor(0x2B2D31)
          .setDescription(sendData.text || '​');
        
        await webhook.send({ embeds: [embed] });
        await webhook.delete();
        
        pendingSends.delete(userId);
        
        await interaction.editReply({
          content: `✅ Сообщение отправлено в ${channel}!`,
          components: [],
          ephemeral: true
        });
        
      } catch (error) {
        console.error('❌ Ошибка:', error);
        await interaction.editReply({
          content: `❌ Ошибка: ${error.message}`,
          components: [],
          ephemeral: true
        });
      }
    }
  }
  
  // ========== МОДАЛЬНЫЕ ОКНА ==========
  if (interaction.isModalSubmit()) {
    const id = interaction.customId;
    
    // Тикет (сервер 1)
    if (isGuild1 && id === 'app_ticket') {
      const name = interaction.fields.getTextInputValue('name');
      const age = parseInt(interaction.fields.getTextInputValue('age'));
      const steam = interaction.fields.getTextInputValue('steam');
      const hours = parseInt(interaction.fields.getTextInputValue('hours'));
      const role = interaction.fields.getTextInputValue('role');
      
      if (isNaN(age)) return interaction.reply({ content: '❌ Возраст - только цифры!', ephemeral: true });
      if (!steam.includes('steamcommunity.com')) return interaction.reply({ content: '❌ Некорректная Steam ссылка!', ephemeral: true });
      if (isNaN(hours)) return interaction.reply({ content: '❌ Часы - только цифры!', ephemeral: true });
      
      if (hours < 3500) {
        stats.denied++;
        stats.weekDenied++;
        stats.autoDenied = (stats.autoDenied || 0) + 1;
        
        return interaction.reply({ 
          embeds: [new EmbedBuilder().setTitle('❌ Отклонено').setDescription(`Часов: ${hours}, нужно: 3500+`).setColor(0xFF0000)], 
          ephemeral: true 
        });
      }
      
      await interaction.reply({ content: '⏳ Создаю тикет...', ephemeral: true });
      
      try {
        const staffRole = cfg.staffRoleId;
        
        const permissionOverwrites = [
          { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
          { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] }
        ];
        
        if (staffRole) {
          permissionOverwrites.push({ id: staffRole, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] });
        }
        
        const shortUsername = interaction.user.username.substring(0, 25);
        const channelOptions = {
          name: `🎫｜${shortUsername}`,
          type: ChannelType.GuildText,
          permissionOverwrites: permissionOverwrites
        };
        
        if (cfg.ticketCategory) {
          try {
            const category = await guild.channels.fetch(cfg.ticketCategory);
            if (category && category.type === ChannelType.GuildCategory) {
              channelOptions.parent = cfg.ticketCategory;
            }
          } catch (error) {}
        }
        
        const channel = await guild.channels.create(channelOptions);
        
        const ticketId = `${interaction.user.id}_ticket`;
        activeTickets.set(ticketId, { 
          channelId: channel.id, 
          userId: interaction.user.id, 
          status: 'pending', 
          createdAt: Date.now() 
        });
        
        scheduleInactiveDelete(channel.id, ticketId);
        
        const embed = new EmbedBuilder()
          .setColor(0x3498DB)
          .setThumbnail(interaction.user.displayAvatarURL())
          .setDescription(`### <@${interaction.user.id}> подал заявку в **European Union**\n━━━━━━━━━━━━━━━━━━\n👤 **Имя:** ${name}\n🎂 **Возраст:** ${age}\n🔗 **Steam:** ${steam}\n⏰ **Часы:** ${hours} ч\n🎯 **Роль:** ${role}${getWorkingHoursMessage()}`);
        
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`accept_${interaction.user.id}`).setEmoji('✅').setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(`consider_${interaction.user.id}`).setEmoji('⏳').setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId(`call_${interaction.user.id}`).setEmoji('📞').setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId(`deny_${interaction.user.id}`).setEmoji('❌').setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId(`close_${channel.id}`).setEmoji('🔒').setStyle(ButtonStyle.Secondary)
        );
        
        let content = '';
        if (staffRole) content = `<@&${staffRole}>`;
        
        await channel.send({ content, embeds: [embed], components: [row] });
        await interaction.editReply({ content: `✅ Заявка создана: ${channel}` });
        
      } catch (error) {
        console.error('❌ Ошибка создания тикета:', error);
        await interaction.editReply({ content: `❌ Ошибка создания: ${error.message}` });
      }
    }
    
    if (isGuild1 && id.startsWith('deny_reason_')) {
      const [_, userId, channelId] = id.split('_');
      const reason = interaction.fields.getTextInputValue('reason');
      
      if (!hasStaff) return interaction.reply({ content: '❌ Нет прав!', ephemeral: true });
      
      await interaction.deferReply({ ephemeral: true });
      
      try {
        const channel = await guild.channels.fetch(channelId).catch(() => null);
        
        stats.denied++;
        stats.weekDenied++;
        
        const ticketId = `${userId}_ticket`;
        clearTimeout(autoDeleteTimeouts.get(ticketId));
        activeTickets.delete(ticketId);
        
        if (channel) {
          await channel.send(`<@${userId}> 😔 **Заявка отклонена.**\n**Причина:** ${reason}`);
          setTimeout(() => channel.delete().catch(() => {}), 5000);
        }
        
        try {
          const targetUser = await client.users.fetch(userId);
          await targetUser.send({
            embeds: [new EmbedBuilder()
              .setTitle('❌ ЗАЯВКА ОТКЛОНЕНА | European Union')
              .setColor(0xFF0000)
              .setDescription(`**Причина:** ${reason}\n\nВы можете подать заявку повторно позже.`)
            ]
          });
        } catch (error) {}
        
        await interaction.editReply({ content: '✅ Заявка отклонена!' });
        
      } catch (error) {
        await interaction.editReply('❌ Ошибка!');
      }
    }
    
    // Отпуск/Отошёл (сервер 2)
    if (isGuild2 && id.startsWith('leave_modal_')) {
      const type = id.replace('leave_modal_', '');
      const timeInput = interaction.fields.getTextInputValue('time');
      const reason = interaction.fields.getTextInputValue('reason') || null;
      
      await interaction.deferReply({ ephemeral: true });
      
      if (type === 'leave_vacation') {
        const days = parseInt(timeInput);
        if (isNaN(days) || days <= 0) {
          return interaction.editReply('❌ Укажите корректное количество дней!');
        }
        
        try {
          const targetMember = interaction.member;
          const today = new Date();
          const endDate = new Date(today);
          endDate.setDate(today.getDate() + days);
          
          const dateStr = `${endDate.getDate().toString().padStart(2, '0')}.${(endDate.getMonth()+1).toString().padStart(2, '0')}.${endDate.getFullYear()}`;
          
          const roleName = `🏖️ Отпуск до ${dateStr}`;
          let leaveRole = guild.roles.cache.find(r => r.name === roleName);
          if (!leaveRole) {
            leaveRole = await guild.roles.create({
              name: roleName,
              color: 0x9B59B6,
              reason: `Отпуск для ${targetMember.user.tag}`
            });
          }
          
          const oldLeaveRoles = targetMember.roles.cache.filter(r => r.name.startsWith('🏖️ Отпуск до'));
          for (const role of oldLeaveRoles.values()) {
            await targetMember.roles.remove(role).catch(() => {});
          }
          
          await targetMember.roles.add(leaveRole);
          
          const messages = await interaction.channel.messages.fetch({ limit: 20 });
          const oldPanel = messages.find(m => m.author.id === client.user.id && m.embeds[0]?.title?.includes('ОТПУСК / ОТСУТСТВИЕ'));
          if (oldPanel) await oldPanel.delete().catch(() => {});
          
          const embed = new EmbedBuilder()
            .setTitle('🏖️ ОТПУСК')
            .setDescription(`**${targetMember.user.tag}** ушёл в отпуск`)
            .addFields(
              { name: '📅 Вернётся', value: dateStr, inline: true },
              { name: '⏰ Дней', value: `${days}`, inline: true }
            )
            .setColor(0x9B59B6)
            .setTimestamp();
          
          if (reason) embed.addFields({ name: '📝 Причина', value: reason, inline: false });
          
          await interaction.channel.send({ embeds: [embed] });
          await createLeavePanel(interaction.channel);
          
          await interaction.editReply({ content: `✅ Вы ушли в отпуск до ${dateStr}!`, ephemeral: true });
          
          const timeUntilReturn = endDate.getTime() - Date.now();
          if (timeUntilReturn > 0) {
            setTimeout(async () => {
              try {
                const m = await guild.members.fetch(targetMember.id).catch(() => null);
                if (m) {
                  await m.roles.remove(leaveRole).catch(() => {});
                  if (leaveRole.members.size === 0) {
                    await leaveRole.delete().catch(() => {});
                  }
                }
              } catch (error) {}
            }, timeUntilReturn);
          }
          
        } catch (error) {
          console.error('❌ Ошибка отпуска:', error);
          await interaction.editReply('❌ Произошла ошибка!');
        }
        
      } else if (type === 'leave_away') {
        const time = parseInt(timeInput);
        if (isNaN(time) || time <= 0) {
          return interaction.editReply('❌ Укажите корректное время!');
        }
        
        const unitInput = interaction.fields.getTextInputValue('unit').toLowerCase();
        let minutes = 0;
        let displayTime = '';
        
        if (unitInput.includes('час') || unitInput === 'ч' || unitInput === 'h') {
          minutes = time * 60;
          displayTime = `${time} час${time === 1 ? '' : 'ов'}`;
        } else if (unitInput.includes('мин') || unitInput === 'м' || unitInput === 'm') {
          minutes = time;
          displayTime = `${time} минут`;
        } else {
          return interaction.editReply('❌ Укажите "мин" или "час"!');
        }
        
        try {
          const targetMember = interaction.member;
          const returnTime = new Date(Date.now() + minutes * 60 * 1000);
          const timeStr = `${returnTime.getHours().toString().padStart(2, '0')}:${returnTime.getMinutes().toString().padStart(2, '0')}`;
          
          const roleName = `🚶 Отошёл до ${timeStr}`;
          let leaveRole = guild.roles.cache.find(r => r.name === roleName);
          if (!leaveRole) {
            leaveRole = await guild.roles.create({
              name: roleName,
              color: 0x95A5A6,
              reason: `Отошёл для ${targetMember.user.tag}`
            });
          }
          
          const oldAwayRoles = targetMember.roles.cache.filter(r => r.name.startsWith('🚶 Отошёл до'));
          for (const role of oldAwayRoles.values()) {
            await targetMember.roles.remove(role).catch(() => {});
          }
          
          await targetMember.roles.add(leaveRole);
          
          const messages = await interaction.channel.messages.fetch({ limit: 20 });
          const oldPanel = messages.find(m => m.author.id === client.user.id && m.embeds[0]?.title?.includes('ОТПУСК / ОТСУТСТВИЕ'));
          if (oldPanel) await oldPanel.delete().catch(() => {});
          
          const embed = new EmbedBuilder()
            .setTitle('🚶 ОТОШЁЛ')
            .setDescription(`**${targetMember.user.tag}** отошёл`)
            .addFields(
              { name: '🕐 Вернётся примерно', value: timeStr, inline: true },
              { name: '⏰ Время', value: displayTime, inline: true }
            )
            .setColor(0x95A5A6)
            .setTimestamp();
          
          if (reason) embed.addFields({ name: '📝 Причина', value: reason, inline: false });
          
          await interaction.channel.send({ embeds: [embed] });
          await createLeavePanel(interaction.channel);
          
          await interaction.editReply({ content: `✅ Вы отошли до ${timeStr}!`, ephemeral: true });
          
          setTimeout(async () => {
            try {
              const m = await guild.members.fetch(targetMember.id).catch(() => null);
              if (m) {
                await m.roles.remove(leaveRole).catch(() => {});
                if (leaveRole.members.size === 0) {
                  await leaveRole.delete().catch(() => {});
                }
              }
            } catch (error) {}
          }, minutes * 60 * 1000);
          
        } catch (error) {
          console.error('❌ Ошибка отошёл:', error);
          await interaction.editReply('❌ Произошла ошибка!');
        }
      }
    }
    
    // Варны (сервер 2)
    if (isGuild2 && id === 'unwarn_modal') {
      const userInput = interaction.fields.getTextInputValue('user');
      
      await interaction.deferReply({ ephemeral: true });
      
      try {
        let userId = userInput;
        const mentionMatch = userInput.match(/<@!?(\d+)>/);
        if (mentionMatch) userId = mentionMatch[1];
        
        const targetMember = await guild.members.fetch(userId).catch(() => null);
        if (!targetMember) return interaction.editReply('❌ Пользователь не найден!');
        
        const removedCount = await removeAllWarns(targetMember);
        
        if (removedCount === 0) {
          return interaction.editReply(`ℹ️ У ${targetMember.user.tag} нет активных предупреждений.`);
        }
        
        const embed = new EmbedBuilder().setTitle('✅ Предупреждения сняты').setColor(0x00FF00)
          .setDescription(`**Пользователь:** <@${targetMember.id}>\n**Модератор:** <@${interaction.user.id}>\n**Снято варнов:** ${removedCount}`);
        
        await interaction.editReply({ embeds: [embed] });
        
        const logEmbed = new EmbedBuilder().setTitle('✅ Варны сняты').setColor(0x00FF00).addFields(
          { name: '👤 Пользователь', value: `<@${targetMember.id}> (${targetMember.user.tag})`, inline: true },
          { name: '👮 Модератор', value: `<@${interaction.user.id}> (${interaction.user.tag})`, inline: true },
          { name: '📊 Количество', value: `${removedCount}`, inline: true }
        );
        
        await sendLog(guild, logEmbed);
        
      } catch (error) {
        console.error('❌ Ошибка:', error);
        await interaction.editReply('❌ Произошла ошибка!');
      }
    }
    
    if (isGuild2 && id === 'warn_modal') {
      const userInput = interaction.fields.getTextInputValue('user');
      const daysInput = interaction.fields.getTextInputValue('days');
      const reason = interaction.fields.getTextInputValue('reason');
      const workoff = interaction.fields.getTextInputValue('workoff') || null;
      
      await interaction.deferReply({ ephemeral: true });
      
      const durationDays = parseInt(daysInput);
      if (isNaN(durationDays) || durationDays <= 0) {
        return interaction.editReply('❌ Срок должен быть положительным числом!');
      }
      
      try {
        let userId = userInput;
        const mentionMatch = userInput.match(/<@!?(\d+)>/);
        if (mentionMatch) userId = mentionMatch[1];
        
        const targetMember = await guild.members.fetch(userId).catch(() => null);
        if (!targetMember) return interaction.editReply('❌ Пользователь не найден!');
        
        const today = new Date();
        const dateStr = `${today.getDate().toString().padStart(2, '0')}.${(today.getMonth()+1).toString().padStart(2, '0')}.${today.getFullYear()}`;
        
        let roleName = `⚠️ Warn (${dateStr}) [${durationDays}д]`;
        if (reason) roleName += ` | 📝 ${reason}`;
        if (workoff) roleName += ` | 🔄 ${workoff}`;
        
        let warnRole = guild.roles.cache.find(r => r.name === roleName);
        if (!warnRole) {
          warnRole = await guild.roles.create({ name: roleName, color: 0xFFA500, reason: `Варн для ${targetMember.user.tag}` });
        }
        
        await targetMember.roles.add(warnRole);
        
        const embed = new EmbedBuilder().setTitle('⚠️ Предупреждение выдано').setColor(0xFFA500)
          .setDescription(`**Пользователь:** <@${targetMember.id}>\n**Модератор:** <@${interaction.user.id}>\n**Причина:** ${reason}\n**Срок:** ${durationDays} дней`);
        
        await interaction.editReply({ embeds: [embed] });
        
        const logEmbed = new EmbedBuilder().setTitle('⚠️ Выдан варн').setColor(0xFFA500).addFields(
          { name: '👤 Пользователь', value: `<@${targetMember.id}> (${targetMember.user.tag})`, inline: true },
          { name: '👮 Модератор', value: `<@${interaction.user.id}> (${interaction.user.tag})`, inline: true },
          { name: '⏰ Срок', value: `${durationDays} дней`, inline: true },
          { name: '📝 Причина', value: reason, inline: false }
        );
        
        if (workoff) logEmbed.addFields({ name: '🔄 Отработка', value: workoff, inline: false });
        
        await sendLog(guild, logEmbed);
        
        try {
          await targetMember.send({ 
            embeds: [new EmbedBuilder().setTitle('⚠️ Вы получили предупреждение').setColor(0xFFA500)
              .setDescription(`**Причина:** ${reason}\n**Срок:** ${durationDays} дней`)] 
          });
        } catch (error) {}
        
      } catch (error) {
        console.error('❌ Ошибка:', error);
        await interaction.editReply('❌ Произошла ошибка!');
      }
    }
    
    if (isGuild2 && id === 'appeal_modal') {
      const reason = interaction.fields.getTextInputValue('reason');
      
      await interaction.deferReply({ ephemeral: true });
      
      try {
        const user = interaction.user;
        const targetMember = interaction.member;
        const warnRoles = targetMember.roles.cache.filter(r => r.name.startsWith('⚠️ Warn ('));
        
        const warnsList = warnRoles.map(role => `- ${role.name}`).join('\n');
        
        const channelOptions = {
          name: `📝-обжалование-${user.username}`,
          type: ChannelType.GuildText,
          permissionOverwrites: [
            { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
            { id: user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] }
          ]
        };
        
        if (cfg.appealCategoryId) {
          const category = await guild.channels.fetch(cfg.appealCategoryId).catch(() => null);
          if (category) channelOptions.parent = cfg.appealCategoryId;
        }
        
        if (cfg.staffRoleId_guild2) {
          channelOptions.permissionOverwrites.push({ id: cfg.staffRoleId_guild2, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] });
        }
        
        const appealChannel = await guild.channels.create(channelOptions);
        
        const embed = new EmbedBuilder()
          .setTitle('📝 ОБЖАЛОВАНИЕ ВАРНА')
          .setColor(0xFFA500)
          .setDescription(`**Пользователь:** <@${user.id}>\n\n**Активные варны:**\n${warnsList}\n\n**Причина обжалования:**\n> ${reason}`);
        
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`remove_warn_${user.id}`).setLabel('Снять варны').setEmoji('✅').setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(`close_ticket_${appealChannel.id}`).setLabel('Закрыть').setEmoji('🔒').setStyle(ButtonStyle.Secondary)
        );
        
        let content = '';
        if (cfg.staffRoleId_guild2) content = `<@&${cfg.staffRoleId_guild2}>`;
        
        await appealChannel.send({ content, embeds: [embed], components: [row] });
        
        await interaction.editReply({ content: `✅ Обращение создано! ${appealChannel}`, ephemeral: true });
        
      } catch (error) {
        console.error('❌ Ошибка:', error);
        await interaction.editReply('❌ Произошла ошибка!');
      }
    }
    
    if (isGuild2 && id === 'workoff_modal') {
      const reason = interaction.fields.getTextInputValue('reason');
      
      await interaction.deferReply({ ephemeral: true });
      
      try {
        const user = interaction.user;
        const targetMember = interaction.member;
        const warnRoles = targetMember.roles.cache.filter(r => r.name.startsWith('⚠️ Warn ('));
        
        const warnsList = warnRoles.map(role => `- ${role.name}`).join('\n');
        
        const channelOptions = {
          name: `✅-отработка-${user.username}`,
          type: ChannelType.GuildText,
          permissionOverwrites: [
            { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
            { id: user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] }
          ]
        };
        
        if (cfg.appealCategoryId) {
          const category = await guild.channels.fetch(cfg.appealCategoryId).catch(() => null);
          if (category) channelOptions.parent = cfg.appealCategoryId;
        }
        
        if (cfg.staffRoleId_guild2) {
          channelOptions.permissionOverwrites.push({ id: cfg.staffRoleId_guild2, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] });
        }
        
        const appealChannel = await guild.channels.create(channelOptions);
        
        const embed = new EmbedBuilder()
          .setTitle('✅ ОТРАБОТКА ВАРНА')
          .setColor(0x00AA00)
          .setDescription(`**Пользователь:** <@${user.id}>\n\n**Активные варны:**\n${warnsList}\n\n**Что сделано:**\n> ${reason}`);
        
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`remove_warn_${user.id}`).setLabel('Снять варны').setEmoji('✅').setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(`close_ticket_${appealChannel.id}`).setLabel('Закрыть').setEmoji('🔒').setStyle(ButtonStyle.Secondary)
        );
        
        let content = '';
        if (cfg.staffRoleId_guild2) content = `<@&${cfg.staffRoleId_guild2}>`;
        
        await appealChannel.send({ content, embeds: [embed], components: [row] });
        
        await interaction.editReply({ content: `✅ Обращение создано! ${appealChannel}`, ephemeral: true });
        
      } catch (error) {
        console.error('❌ Ошибка:', error);
        await interaction.editReply('❌ Произошла ошибка!');
      }
    }
    
    // Фото для /send
    if (id.startsWith('send_modal_')) {
      const userId = id.replace('send_modal_', '');
      const photoUrl = interaction.fields.getTextInputValue('photo_url');
      
      const sendData = pendingSends.get(userId);
      if (!sendData) {
        return interaction.reply({ content: '❌ Данные не найдены!', ephemeral: true });
      }
      
      await interaction.deferReply({ ephemeral: true });
      
      try {
        const channel = await client.channels.fetch(sendData.channelId);
        
        const webhook = await channel.createWebhook({
          name: sendData.customName,
          avatar: sendData.avatarUrl
        });
        
        const files = [];
        let fileName = 'image.png';
        
        if (photoUrl.startsWith('http://') || photoUrl.startsWith('https://')) {
          const response = await fetch(photoUrl);
          const buffer = Buffer.from(await response.arrayBuffer());
          const contentType = response.headers.get('content-type') || '';
          
          if (contentType.includes('png')) fileName = 'image.png';
          else if (contentType.includes('webp')) fileName = 'image.webp';
          else if (contentType.includes('gif')) fileName = 'image.gif';
          
          files.push({ attachment: buffer, name: fileName });
        } else {
          if (fs.existsSync(photoUrl)) {
            fileName = photoUrl.split('/').pop() || 'image.png';
            files.push({ attachment: photoUrl, name: fileName });
          } else {
            await webhook.delete();
            return interaction.editReply('❌ Файл не найден!');
          }
        }
        
        const embed = new EmbedBuilder()
          .setColor(0x2B2D31)
          .setImage(`attachment://${fileName}`)
          .setDescription(sendData.text || null);
        
        await webhook.send({ embeds: [embed], files: files });
        await webhook.delete();
        
        pendingSends.delete(userId);
        
        await interaction.editReply({ content: `✅ Сообщение с фото отправлено!` });
        
      } catch (error) {
        console.error('❌ Ошибка:', error);
        await interaction.editReply(`❌ Ошибка: ${error.message}`);
      }
    }
  }
});

// ========== ОБРАБОТКА ОШИБОК ==========
client.on('error', e => console.error('❌ Ошибка клиента:', e));
process.on('unhandledRejection', e => console.error('❌ Необработанное отклонение:', e));

// ========== ЗАПУСК ==========
const token = process.env.DISCORD_TOKEN;
if (!token) { 
  console.error('❌ ТОКЕН НЕ НАЙДЕН!'); 
  process.exit(1); 
}

client.login(token);

// ========== HTTP СЕРВЕР ==========
http.createServer((req, res) => { 
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); 
  const backup = globalBackup.get('last_backup');
  res.end(`
    <!DOCTYPE html>
    <html>
    <head><title>European Union Bot</title>
    <style>
      body { font-family: Arial; text-align: center; padding: 50px; background: #1a1a2e; color: #eee; }
      h1 { color: #3498db; }
    </style>
    </head>
    <body>
      <h1>🇪🇺 European Union Bot</h1>
      <p>✅ Бот работает!</p>
      <p>⏰ Аптайм: ${getUptime()}</p>
    </body>
    </html>
  `); 
}).listen(process.env.PORT || 3000);

console.log(`🌐 HTTP сервер запущен на порту ${process.env.PORT || 3000}`);
