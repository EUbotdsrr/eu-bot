const { Client, GatewayIntentBits, EmbedBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits, ChannelType, Collection } = require('discord.js');
const express = require('express');
const mongoose = require('mongoose');
require('dotenv').config();

// ============== КОНФИГУРАЦИЯ ==============
const CONFIG = {
    token: process.env.DISCORD_TOKEN,
    mongoURI: process.env.MONGODB_URI,
    guildId: process.env.GUILD_ID,
    ticketCategory: process.env.TICKET_CATEGORY,
    staffRoleStack1: process.env.STAFF_ROLE_STACK1,
    staffRoleStack2: process.env.STAFF_ROLE_STACK2,
    logChannelId: process.env.LOG_CHANNEL_ID,
    memberRoleId: process.env.MEMBER_ROLE_ID,
    
    // Настройки для Render (ВАЖНО!)
    keepAlivePort: process.env.PORT || 3000,
    keepAliveInterval: 30000, // Пинг каждые 30 секунд
    
    // Защита от сноса
    antinos: {
        maxDeletes: 3,
        timeWindow: 10000,
        timeoutDuration: 86400000
    },
    
    // Настройки тикетов
    tickets: {
        inactiveHours: 48,
        deleteDelay: 5000,
        maxPerUser: 3
    }
};

// ============== ИНИЦИАЛИЗАЦИЯ ==============
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildBans
    ],
    partials: ['CHANNEL', 'MESSAGE']
});

// Коллекции для данных
const channelDeleteLog = new Collection();
const deletedChannels = new Collection();
const activeTickets = new Collection();
const autoDeleteTimeouts = new Collection();
const pendingSends = new Collection();
const cooldowns = new Collection();
let staffStats = new Collection();
let ticketStatus = { stack1: true, stack2: true };
let stats = {
    stack1: { accepted: 0, denied: 0, autoDenied: 0, weekAccepted: 0, weekDenied: 0, weekStart: Date.now() },
    stack2: { accepted: 0, denied: 0, autoDenied: 0, weekAccepted: 0, weekDenied: 0, weekStart: Date.now() }
};

// MongoDB схема (если используешь Mongoose)
let Backup;
if (CONFIG.mongoURI) {
    const backupSchema = new mongoose.Schema({
        guildId: String,
        guildName: String,
        createdAt: { type: Date, default: Date.now, expires: 2592000 },
        createdBy: String,
        categories: Array,
        standaloneChannels: Array
    });
    Backup = mongoose.model('Backup', backupSchema);
}

// ============== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ==============
function getUptime() {
    const diff = Date.now() - client.readyTimestamp;
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));
    const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
    return `${days > 0 ? days + 'д ' : ''}${hours > 0 ? hours + 'ч ' : ''}${minutes}м`;
}

function getWorkingHoursMessage() {
    const now = new Date();
    const mskHour = (now.getUTCHours() + 3) % 24;
    if (mskHour >= 10 && mskHour < 21) return '';
    return `\n**━━━━━━━━━━━━━━━━━━━━━━━━━━**\n⏰ *Заявки рассматриваются с 10:00 до 21:00 по МСК.*`;
}

function checkCooldown(userId, commandName, seconds = 5) {
    const key = `${userId}_${commandName}`;
    const now = Date.now();
    const cooldown = cooldowns.get(key);
    
    if (cooldown && now < cooldown) {
        return Math.ceil((cooldown - now) / 1000);
    }
    
    cooldowns.set(key, now + seconds * 1000);
    setTimeout(() => cooldowns.delete(key), seconds * 1000);
    return 0;
}

async function sendLog(guild, embed) {
    if (!CONFIG.logChannelId) return;
    try {
        const channel = await guild.channels.fetch(CONFIG.logChannelId).catch(() => null);
        if (channel) await channel.send({ embeds: [embed] });
    } catch (error) {
        console.error('❌ Log error:', error.message);
    }
}

async function updateStaffRole(guild, staffId, acceptedCount) {
    try {
        const member = await guild.members.fetch(staffId).catch(() => null);
        if (!member) return;
        
        const roleName = `📋 Принял ${acceptedCount} заявок`;
        const oldRoles = member.roles.cache.filter(r => r.name.startsWith('📋 Принял '));
        
        for (const role of oldRoles.values()) {
            await member.roles.remove(role).catch(() => {});
            if (role.members.size === 1) await role.delete().catch(() => {});
        }
        
        let newRole = guild.roles.cache.find(r => r.name === roleName);
        if (!newRole) {
            newRole = await guild.roles.create({
                name: roleName,
                color: 0x3498DB,
                reason: `Статистика для ${member.user.tag}`
            });
        }
        
        await member.roles.add(newRole);
    } catch (error) {
        console.error('❌ Role error:', error.message);
    }
}

function scheduleInactiveDelete(channelId, ticketId) {
    if (autoDeleteTimeouts.has(ticketId)) {
        clearTimeout(autoDeleteTimeouts.get(ticketId));
    }
    
    const timeout = setTimeout(async () => {
        try {
            const channel = await client.channels.fetch(channelId).catch(() => null);
            if (channel) {
                const messages = await channel.messages.fetch({ limit: 5 });
                const botMessages = messages.filter(m => m.author.id === client.user.id);
                
                if (messages.size <= 1 || (messages.size === 2 && botMessages.size >= 1)) {
                    await channel.send('🗑️ **Тикет автоматически закрыт (неактивность 48 часов).**');
                    setTimeout(() => channel.delete().catch(() => {}), 5000);
                }
            }
            activeTickets.delete(ticketId);
            autoDeleteTimeouts.delete(ticketId);
        } catch (error) {
            console.error('❌ Auto-delete error:', error.message);
        }
    }, CONFIG.tickets.inactiveHours * 60 * 60 * 1000);
    
    autoDeleteTimeouts.set(ticketId, timeout);
}

// ============== ЗАЩИТА ОТ СНОСА ==============
client.on('channelDelete', async (channel) => {
    if (channel.type === ChannelType.DM || !channel.guild) return;
    
    try {
        const auditLogs = await channel.guild.fetchAuditLogs({ type: 12, limit: 1 });
        const deleteLog = auditLogs.entries.first();
        if (!deleteLog || deleteLog.executor.bot) return;
        
        const { executor } = deleteLog;
        
        if (executor.id === channel.guild.ownerId || executor.permissions.has(PermissionFlagsBits.Administrator)) {
            return;
        }
        
        const channelData = {
            name: channel.name,
            type: channel.type === ChannelType.GuildText ? 'text' : (channel.type === ChannelType.GuildVoice ? 'voice' : 'category'),
            parentId: channel.parentId,
            position: channel.position,
            topic: channel.topic || null,
            nsfw: channel.nsfw || false,
            rateLimitPerUser: channel.rateLimitPerUser || 0,
            bitrate: channel.bitrate || null,
            userLimit: channel.userLimit || null
        };
        
        deletedChannels.set(channel.id, channelData);
        setTimeout(() => deletedChannels.delete(channel.id), 3600000);
        
        const now = Date.now();
        const userLog = channelDeleteLog.get(executor.id) || { count: 0, firstDeleteTime: now };
        userLog.count++;
        userLog.firstDeleteTime = userLog.firstDeleteTime || now;
        channelDeleteLog.set(executor.id, userLog);
        
        if (userLog.count >= CONFIG.antinos.maxDeletes && (now - userLog.firstDeleteTime) <= CONFIG.antinos.timeWindow) {
            console.log(`🚨 ANTI-NUKE: ${executor.tag} deleted ${userLog.count} channels!`);
            
            await executor.timeout(CONFIG.antinos.timeoutDuration, 'Anti-nuke: массовое удаление каналов').catch(() => {});
            
            let restoredCount = 0;
            for (const [chId, chData] of deletedChannels) {
                try {
                    if (chData.type === 'text') {
                        await channel.guild.channels.create({
                            name: chData.name,
                            type: ChannelType.GuildText,
                            parent: chData.parentId,
                            position: chData.position,
                            topic: chData.topic || undefined,
                            nsfw: chData.nsfw,
                            rateLimitPerUser: chData.rateLimitPerUser
                        });
                        restoredCount++;
                    } else if (chData.type === 'voice') {
                        await channel.guild.channels.create({
                            name: chData.name,
                            type: ChannelType.GuildVoice,
                            parent: chData.parentId,
                            position: chData.position,
                            bitrate: chData.bitrate || 64000,
                            userLimit: chData.userLimit || 0
                        });
                        restoredCount++;
                    }
                } catch (e) {}
            }
            
            const logEmbed = new EmbedBuilder()
                .setTitle('🚨 ANTI-NUKE ACTIVATED')
                .setColor(0xFF0000)
                .addFields(
                    { name: '👤 Нарушитель', value: `${executor.tag} (${executor.id})`, inline: true },
                    { name: '🗑️ Удалено', value: `${userLog.count}`, inline: true },
                    { name: '🔄 Восстановлено', value: `${restoredCount}`, inline: true }
                )
                .setTimestamp();
            
            await sendLog(channel.guild, logEmbed);
            channelDeleteLog.delete(executor.id);
        }
    } catch (error) {
        console.error('❌ Anti-nuke error:', error.message);
    }
});

// ============== ОЧИСТКА ПОТОКОВ (ВАЖНО ДЛЯ RENDER!) ==============
setInterval(() => {
    const now = Date.now();
    // Очистка лога удалений
    for (const [userId, data] of channelDeleteLog) {
        if (now - data.firstDeleteTime > CONFIG.antinos.timeWindow) {
            channelDeleteLog.delete(userId);
        }
    }
    
    // Очистка старых таймаутов
    if (autoDeleteTimeouts.size > 100) {
        const toDelete = [...autoDeleteTimeouts.keys()].slice(0, 50);
        for (const key of toDelete) {
            clearTimeout(autoDeleteTimeouts.get(key));
            autoDeleteTimeouts.delete(key);
        }
    }
}, 60000); // Каждую минуту, а не 10 секунд

// ============== СОЗДАНИЕ ТИКЕТА ==============
async function createTicketMessage(channel, stackType) {
    const isStack1 = stackType === 'stack1';
    const stackName = isStack1 ? 'СТАК 1' : 'СТАК 2';
    const hours = isStack1 ? '3500' : '2500';
    
    const embed = new EmbedBuilder()
        .setTitle(`📋 ПОДАТЬ ЗАЯВКУ В КЛАН WT | ${stackName}`)
        .setDescription(
            `**ТРЕБОВАНИЯ ДЛЯ ${stackName}:**\n\n` +
            `● ${hours}+ часов на аккаунте\n● 15+ лет\n● Хороший микрофон\n` +
            `● Умение слушать коллы\n● 6+ часов стабильного онлайна в день\n\n` +
            `**Статус набора:** ${ticketStatus[stackType] ? '🟢 ОТКРЫТ' : '🔴 ЗАКРЫТ'}\n\n` +
            `Нажмите кнопку ниже, чтобы заполнить анкету.`
        )
        .setColor(0x3498DB)
        .setTimestamp();

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`create_ticket_${stackType}`)
            .setLabel(`📝 Подать заявку в ${stackName}`)
            .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
            .setCustomId(`toggle_${stackType}`)
            .setEmoji(ticketStatus[stackType] ? '🟢' : '🔴')
            .setStyle(ButtonStyle.Secondary)
    );

    return await channel.send({ embeds: [embed], components: [row] });
}

// ============== РЕГИСТРАЦИЯ КОМАНД ==============
async function registerCommands() {
    try {
        await client.application.commands.set([
            { name: 'ticket_stack1', description: 'Создать сообщение для СТАК 1 (3500+ часов)' },
            { name: 'ticket_stack2', description: 'Создать сообщение для СТАК 2 (2500+ часов)' },
            { name: 'stats', description: 'Показать статистику заявок' },
            { name: 'battlemetrics', description: 'Показать BattleMetrics профиль' },
            { name: 'ping', description: 'Проверить задержку бота' },
            { name: 'uptime', description: 'Показать время работы бота' },
            {
                name: 'send',
                description: 'Отправить сообщение от имени бота',
                options: [
                    { name: 'channel', description: 'Канал', type: 7, required: true },
                    { name: 'text', description: 'Текст', type: 3, required: false },
                    { name: 'name', description: 'Имя отправителя', type: 3, required: false },
                    { name: 'avatar', description: 'URL аватарки', type: 3, required: false }
                ]
            },
            {
                name: 'deletechannel',
                description: 'Удалить канал по ID',
                options: [{ name: 'channel_id', description: 'ID канала', type: 3, required: true }]
            },
            { name: 'unbanall', description: 'Разбанить всех (только админ)' },
            { name: 'backup', description: 'Создать бэкап структуры сервера' },
            { name: 'backups', description: 'Список бэкапов' },
            { name: 'restore', description: 'Восстановить сервер из бэкапа' }
        ]);
        console.log('✅ Commands registered');
    } catch (error) {
        console.error('❌ Command registration error:', error.message);
    }
}

// ============== ОБРАБОТЧИК ВЗАИМОДЕЙСТВИЙ ==============
client.on('interactionCreate', async interaction => {
    const hasStaff = (CONFIG.staffRoleStack1 && interaction.member?.roles?.cache?.has(CONFIG.staffRoleStack1)) || 
                     (CONFIG.staffRoleStack2 && interaction.member?.roles?.cache?.has(CONFIG.staffRoleStack2)) ||
                     interaction.member?.permissions?.has(PermissionFlagsBits.Administrator);
    
    // КОМАНДА /uptime
    if (interaction.isCommand() && interaction.commandName === 'uptime') {
        return interaction.reply({ 
            content: `🟢 **Бот работает:** ${getUptime()}\n📊 **Пинг:** ${client.ws.ping}ms`, 
            ephemeral: true 
        });
    }
    
    // КОМАНДА /ping
    if (interaction.isCommand() && interaction.commandName === 'ping') {
        const sent = await interaction.reply({ content: '🏓 Пинг...', fetchReply: true, ephemeral: true });
        await interaction.editReply(`🏓 Понг! ${sent.createdTimestamp - interaction.createdTimestamp}ms | API: ${client.ws.ping}ms`);
    }
    
    // КОМАНДА /stats
    if (interaction.isCommand() && interaction.commandName === 'stats') {
        if (!hasStaff) return interaction.reply({ content: '❌ Нет прав!', ephemeral: true });
        
        const totalAccepted = stats.stack1.weekAccepted + stats.stack2.weekAccepted;
        const totalDenied = stats.stack1.weekDenied + stats.stack2.weekDenied;
        
        const embed = new EmbedBuilder()
            .setTitle('📊 СТАТИСТИКА ЗА НЕДЕЛЮ')
            .setColor(0x3498DB)
            .addFields(
                { name: '🔥 СТАК 1', value: `✅ ${stats.stack1.weekAccepted} | ❌ ${stats.stack1.weekDenied}`, inline: true },
                { name: '💧 СТАК 2', value: `✅ ${stats.stack2.weekAccepted} | ❌ ${stats.stack2.weekDenied}`, inline: true },
                { name: '━━━━━━━━━━━━', value: `🎯 **Всего:** ✅ ${totalAccepted} | ❌ ${totalDenied}`, inline: false },
                { name: '🔧 Статус', value: `🔥 ${ticketStatus.stack1 ? '🟢' : '🔴'} | 💧 ${ticketStatus.stack2 ? '🟢' : '🔴'}`, inline: true }
            )
            .setTimestamp();
        
        await interaction.reply({ embeds: [embed], ephemeral: true });
    }
    
    // КОМАНДА /ticket_stack1 и /ticket_stack2
    if (interaction.isCommand() && (interaction.commandName === 'ticket_stack1' || interaction.commandName === 'ticket_stack2')) {
        if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
            return interaction.reply({ content: '❌ Нет прав!', ephemeral: true });
        }
        const stack = interaction.commandName === 'ticket_stack1' ? 'stack1' : 'stack2';
        await createTicketMessage(interaction.channel, stack);
        await interaction.reply({ content: `✅ Сообщение для ${stack === 'stack1' ? 'СТАК 1' : 'СТАК 2'} создано!`, ephemeral: true });
    }
    
    // КНОПКА ОТКРЫТИЯ ТИКЕТА
    if (interaction.isButton() && interaction.customId.startsWith('create_ticket_')) {
        const stack = interaction.customId.replace('create_ticket_', '');
        if (!ticketStatus[stack]) {
            return interaction.reply({ content: '❌ Набор временно закрыт!', ephemeral: true });
        }
        
        // Проверка на количество активных тикетов
        const userTickets = [...activeTickets.values()].filter(t => t.userId === interaction.user.id);
        if (userTickets.length >= CONFIG.tickets.maxPerUser) {
            return interaction.reply({ 
                content: `❌ У вас уже есть ${userTickets.length} активных заявок. Закройте старые, чтобы подать новую.`, 
                ephemeral: true 
            });
        }
        
        const modal = new ModalBuilder()
            .setCustomId(`app_${stack}`)
            .setTitle(`Заявка в ${stack === 'stack1' ? 'СТАК 1' : 'СТАК 2'}`);
        
        modal.addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder().setCustomId('name').setLabel('Имя').setPlaceholder('Артём').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(50)
            ),
            new ActionRowBuilder().addComponents(
                new TextInputBuilder().setCustomId('age').setLabel('Возраст').setPlaceholder('15').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(3)
            ),
            new ActionRowBuilder().addComponents(
                new TextInputBuilder().setCustomId('steam').setLabel('Steam ссылка').setPlaceholder('https://steamcommunity.com/...').setStyle(TextInputStyle.Short).setRequired(true)
            ),
            new ActionRowBuilder().addComponents(
                new TextInputBuilder().setCustomId('hours').setLabel(`Часы (нужно ${stack === 'stack1' ? '3500+' : '2500+'})`).setPlaceholder(stack === 'stack1' ? '3500' : '2500').setStyle(TextInputStyle.Short).setRequired(true)
            ),
            new ActionRowBuilder().addComponents(
                new TextInputBuilder().setCustomId('role').setLabel('Роль').setPlaceholder('Строитель, ПвПшник...').setStyle(TextInputStyle.Short).setRequired(true)
            )
        );
        
        await interaction.showModal(modal);
    }
    
    // КНОПКА СТАТУСА НАБОРА
    if (interaction.isButton() && (interaction.customId === 'toggle_stack1' || interaction.customId === 'toggle_stack2')) {
        if (!hasStaff) return interaction.reply({ content: '❌ Нет прав!', ephemeral: true });
        
        const stack = interaction.customId === 'toggle_stack1' ? 'stack1' : 'stack2';
        ticketStatus[stack] = !ticketStatus[stack];
        
        const embed = EmbedBuilder.from(interaction.message.embeds[0]);
        const description = embed.data.description.replace(/Статус набора: [🟢🔴]+[А-Я]+/, `Статус набора: ${ticketStatus[stack] ? '🟢 ОТКРЫТ' : '🔴 ЗАКРЫТ'}`);
        embed.setDescription(description);
        
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`create_ticket_${stack}`).setLabel(`📝 Подать заявку в ${stack === 'stack1' ? 'СТАК 1' : 'СТАК 2'}`).setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId(`toggle_${stack}`).setEmoji(ticketStatus[stack] ? '🟢' : '🔴').setStyle(ButtonStyle.Secondary)
        );
        
        await interaction.update({ embeds: [embed], components: [row] });
        
        const logEmbed = new EmbedBuilder()
            .setTitle(ticketStatus[stack] ? '🟢 НАБОР ОТКРЫТ' : '🔴 НАБОР ЗАКРЫТ')
            .setColor(ticketStatus[stack] ? 0x00FF00 : 0xFF0000)
            .addFields({ name: '👮 Стафф', value: `<@${interaction.user.id}>`, inline: true })
            .setTimestamp();
        
        await sendLog(interaction.guild, logEmbed);
    }
    
    // ОБРАБОТКА ЗАЯВКИ
    if (interaction.isModalSubmit() && interaction.customId.startsWith('app_')) {
        const stack = interaction.customId.replace('app_', '');
        const name = interaction.fields.getTextInputValue('name');
        const age = parseInt(interaction.fields.getTextInputValue('age'));
        const steam = interaction.fields.getTextInputValue('steam');
        const hours = parseInt(interaction.fields.getTextInputValue('hours'));
        const role = interaction.fields.getTextInputValue('role');
        
        if (isNaN(age)) return interaction.reply({ content: '❌ Возраст - только цифры!', ephemeral: true });
        if (!steam.includes('steamcommunity.com')) return interaction.reply({ content: '❌ Некорректная Steam ссылка!', ephemeral: true });
        if (isNaN(hours)) return interaction.reply({ content: '❌ Часы - только цифры!', ephemeral: true });
        
        const minHours = stack === 'stack1' ? 3500 : 2500;
        if (hours < minHours) {
            if (stack === 'stack1') {
                stats.stack1.denied++;
                stats.stack1.weekDenied++;
                stats.stack1.autoDenied++;
            } else {
                stats.stack2.denied++;
                stats.stack2.weekDenied++;
                stats.stack2.autoDenied++;
            }
            
            return interaction.reply({ 
                embeds: [new EmbedBuilder().setTitle('❌ Отклонено').setDescription(`Необходимо ${minHours}+ часов, у вас ${hours}`).setColor(0xFF0000)], 
                ephemeral: true 
            });
        }
        
        await interaction.reply({ content: '⏳ Создаю тикет...', ephemeral: true });
        
        try {
            const staffRole = stack === 'stack1' ? CONFIG.staffRoleStack1 : CONFIG.staffRoleStack2;
            
            const permissionOverwrites = [
                { id: interaction.guild.id, deny: [PermissionFlagsBits.ViewChannel] },
                { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] }
            ];
            
            if (staffRole) {
                permissionOverwrites.push({ id: staffRole, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] });
            }
            
            const channel = await interaction.guild.channels.create({
                name: `${stack === 'stack1' ? '🔥' : '💧'}｜${interaction.user.username}`,
                type: ChannelType.GuildText,
                parent: CONFIG.ticketCategory || undefined,
                permissionOverwrites: permissionOverwrites
            });
            
            const ticketId = `${interaction.user.id}_${stack}`;
            activeTickets.set(ticketId, { channelId: channel.id, userId: interaction.user.id, stackType: stack, createdAt: Date.now() });
            scheduleInactiveDelete(channel.id, ticketId);
            
            const embed = new EmbedBuilder()
                .setColor(0x3498DB)
                .setThumbnail(interaction.user.displayAvatarURL())
                .setDescription(`### <@${interaction.user.id}> подал заявку в **${stack === 'stack1' ? 'СТАК-1' : 'СТАК-2'}**\n━━━━━━━━━━━━━━━━━━\n👤 **Имя:** ${name}\n🎂 **Возраст:** ${age}\n🔗 **Steam:** ${steam}\n⏰ **Часы:** ${hours} ч\n🎯 **Роль:** ${role}${getWorkingHoursMessage()}`);
            
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`accept_${interaction.user.id}_${stack}`).setLabel('✅ Принять').setStyle(ButtonStyle.Success),
                new ButtonBuilder().setCustomId(`consider_${interaction.user.id}_${stack}`).setLabel('⏳ Рассмотреть').setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId(`call_${interaction.user.id}_${stack}`).setLabel('📞 Обзвон').setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId(`deny_${interaction.user.id}_${stack}`).setLabel('❌ Отклонить').setStyle(ButtonStyle.Danger),
                new ButtonBuilder().setCustomId(`close_${channel.id}`).setLabel('🔒 Закрыть').setStyle(ButtonStyle.Secondary)
            );
            
            await channel.send({ content: staffRole ? `<@&${staffRole}>` : '', embeds: [embed], components: [row] });
            await interaction.editReply({ content: `✅ Заявка создана: ${channel}` });
            
            const logEmbed = new EmbedBuilder()
                .setTitle('📝 Новая заявка')
                .setColor(0x3498DB)
                .addFields(
                    { name: '👤 Заявитель', value: `<@${interaction.user.id}>`, inline: true },
                    { name: '📋 Состав', value: stack === 'stack1' ? 'СТАК 1' : 'СТАК 2', inline: true },
                    { name: '⏰ Часы', value: `${hours}`, inline: true }
                )
                .setTimestamp();
            
            await sendLog(interaction.guild, logEmbed);
        } catch (error) {
            console.error('❌ Ticket creation error:', error.message);
            await interaction.editReply('❌ Ошибка создания тикета!');
        }
    }
    
    // КНОПКИ УПРАВЛЕНИЯ ТИКЕТОМ
    if (interaction.isButton()) {
        const id = interaction.customId;
        
        if (id.startsWith('close_')) {
            if (!hasStaff) return interaction.reply({ content: '❌ Нет прав!', ephemeral: true });
            
            await interaction.reply({ content: '🔒 Закрываю тикет...', ephemeral: true });
            const channelId = id.split('_')[1];
            
            for (const [tid, ticket] of activeTickets) {
                if (ticket.channelId === channelId) {
                    clearTimeout(autoDeleteTimeouts.get(tid));
                    activeTickets.delete(tid);
                    break;
                }
            }
            
            setTimeout(async () => {
                const channel = await interaction.guild.channels.fetch(channelId).catch(() => null);
                if (channel) await channel.delete().catch(() => {});
            }, 2000);
        }
        
        if (id.startsWith('accept_') || id.startsWith('consider_') || id.startsWith('call_') || id.startsWith('deny_')) {
            if (!hasStaff) return interaction.reply({ content: '❌ Нет прав!', ephemeral: true });
            
            const [action, userId, stack] = id.split('_');
            const ticketId = `${userId}_${stack}`;
            clearTimeout(autoDeleteTimeouts.get(ticketId));
            
            if (action === 'accept') {
                if (stack === 'stack1') {
                    stats.stack1.accepted++;
                    stats.stack1.weekAccepted++;
                } else {
                    stats.stack2.accepted++;
                    stats.stack2.weekAccepted++;
                }
                
                if (CONFIG.memberRoleId) {
                    await interaction.guild.members.fetch(userId).then(m => m.roles.add(CONFIG.memberRoleId)).catch(() => {});
                }
                
                await interaction.update({ embeds: [EmbedBuilder.from(interaction.message.embeds[0]).setColor(0x00FF00)], components: [] });
                await interaction.channel.send(`<@${userId}> 🎉 **Заявка принята!** Добро пожаловать в команду!`);
                
                setTimeout(() => interaction.channel.delete().catch(() => {}), 30 * 60 * 1000);
                
                const logEmbed = new EmbedBuilder()
                    .setTitle('✅ Заявка принята')
                    .setColor(0x00FF00)
                    .addFields(
                        { name: '👤 Заявитель', value: `<@${userId}>`, inline: true },
                        { name: '👮 Стафф', value: `<@${interaction.user.id}>`, inline: true },
                        { name: '📋 Состав', value: stack === 'stack1' ? 'СТАК 1' : 'СТАК 2', inline: true }
                    )
                    .setTimestamp();
                
                await sendLog(interaction.guild, logEmbed);
                activeTickets.delete(ticketId);
            }
            
            if (action === 'deny') {
                const modal = new ModalBuilder()
                    .setCustomId(`deny_reason_${userId}_${stack}_${interaction.channel.id}`)
                    .setTitle('❌ Причина отклонения');
                
                modal.addComponents(new ActionRowBuilder().addComponents(
                    new TextInputBuilder().setCustomId('reason').setLabel('Причина').setPlaceholder('Укажите причину...').setStyle(TextInputStyle.Paragraph).setRequired(true)
                ));
                
                await interaction.showModal(modal);
            }
        }
    }
    
    // ОТКЛОНЕНИЕ С ПРИЧИНОЙ
    if (interaction.isModalSubmit() && interaction.customId.startsWith('deny_reason_')) {
        const [_, userId, stack, channelId] = interaction.customId.split('_');
        const reason = interaction.fields.getTextInputValue('reason');
        
        if (!hasStaff) return interaction.reply({ content: '❌ Нет прав!', ephemeral: true });
        
        await interaction.deferReply({ ephemeral: true });
        
        if (stack === 'stack1') {
            stats.stack1.denied++;
            stats.stack1.weekDenied++;
        } else {
            stats.stack2.denied++;
            stats.stack2.weekDenied++;
        }
        
        const ticketId = `${userId}_${stack}`;
        clearTimeout(autoDeleteTimeouts.get(ticketId));
        activeTickets.delete(ticketId);
        
        const channel = await interaction.guild.channels.fetch(channelId).catch(() => null);
        if (channel) {
            await channel.send(`<@${userId}> ❌ **Заявка отклонена**\n📝 **Причина:** ${reason}`);
            setTimeout(() => channel.delete().catch(() => {}), 5000);
        }
        
        try {
            const user = await client.users.fetch(userId);
            await user.send({
                embeds: [new EmbedBuilder()
                    .setTitle(`❌ ЗАЯВКА ОТКЛОНЕНА | ${stack === 'stack1' ? 'СТАК 1' : 'СТАК 2'}`)
                    .setColor(0xFF0000)
                    .setDescription(`**Причина:** ${reason}\n\nВы можете подать заявку повторно позже.`)
                ]
            });
        } catch (error) {}
        
        await interaction.editReply({ content: '✅ Заявка отклонена!' });
        
        const logEmbed = new EmbedBuilder()
            .setTitle('❌ Заявка отклонена')
            .setColor(0xFF0000)
            .addFields(
                { name: '👤 Заявитель', value: `<@${userId}>`, inline: true },
                { name: '👮 Стафф', value: `<@${interaction.user.id}>`, inline: true },
                { name: '📋 Состав', value: stack === 'stack1' ? 'СТАК 1' : 'СТАК 2', inline: true },
                { name: '📝 Причина', value: reason, inline: false }
            )
            .setTimestamp();
        
        await sendLog(interaction.guild, logEmbed);
    }
});

// ============== KEEP-ALIVE СЕРВЕР ДЛЯ RENDER ==============
const app = express();

app.get('/', (req, res) => {
    res.json({
        status: 'online',
        uptime: getUptime(),
        ping: client.ws.ping,
        guilds: client.guilds.cache.size,
        timestamp: new Date().toISOString()
    });
});

app.get('/health', (req, res) => {
    res.status(200).send('OK');
});

// Автоматический пинг каждые 30 секунд (держит бота живым)
setInterval(async () => {
    try {
        const response = await fetch(`http://localhost:${CONFIG.keepAlivePort}/health`);
        console.log(`💓 Keep-alive ping: ${response.status}`);
    } catch (error) {
        console.error('⚠️ Keep-alive error:', error.message);
    }
}, CONFIG.keepAliveInterval);

app.listen(CONFIG.keepAlivePort, () => {
    console.log(`🌐 Keep-alive server running on port ${CONFIG.keepAlivePort}`);
});

// ============== ЗАПУСК БОТА ==============
client.once('ready', async () => {
    console.log(`✅ Бот ${client.user.tag} запущен!`);
    console.log(`📊 Статистика: ${client.guilds.cache.size} серверов, ${client.users.cache.size} пользователей`);
    
    await registerCommands();
    
    // Обновление статуса
    const updateStatus = () => {
        client.user.setActivity(`❤️ ${getUptime()} | /help`, { type: 3 });
    };
    updateStatus();
    setInterval(updateStatus, 60000);
    
    // Подключение к MongoDB
    if (CONFIG.mongoURI) {
        try {
            await mongoose.connect(CONFIG.mongoURI, {
                serverSelectionTimeoutMS: 5000,
                socketTimeoutMS: 45000
            });
            console.log('✅ MongoDB connected');
        } catch (error) {
            console.error('❌ MongoDB connection failed:', error.message);
        }
    }
    
    console.log('🚀 Бот полностью готов к работе!');
});

// Обработка ошибок
client.on('error', error => console.error('❌ Client error:', error.message));
process.on('unhandledRejection', error => console.error('❌ Unhandled rejection:', error.message));
process.on('SIGTERM', () => {
    console.log('🛑 Received SIGTERM, cleaning up...');
    client.destroy();
    process.exit(0);
});

// ЗАПУСК
if (!CONFIG.token) {
    console.error('❌ DISCORD_TOKEN не найден! Проверь .env файл');
    process.exit(1);
}

client.login(CONFIG.token);
console.log('🟢 Бот запускается...');
