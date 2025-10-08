'use strict';

const express = require('express');
const cors = require('cors');
const { google } = require('googleapis');
const { Resend } = require('resend');
const { DateTime } = require('luxon');
require('dotenv').config();

/* ===== Credenciais do serviço ===== */
const credentials = {
  type: process.env.GOOGLE_TYPE,
  project_id: process.env.GOOGLE_PROJECT_ID,
  private_key_id: process.env.GOOGLE_PRIVATE_KEY_ID,
  private_key: process.env.GOOGLE_PRIVATE_KEY
    ? process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n')
    : undefined,
  client_email: process.env.GOOGLE_CLIENT_EMAIL,
  client_id: process.env.GOOGLE_CLIENT_ID,
  auth_uri: process.env.GOOGLE_AUTH_URI,
  token_uri: process.env.GOOGLE_TOKEN_URI,
  auth_provider_x509_cert_url: process.env.GOOGLE_AUTH_PROVIDER_CERT_URL,
  client_x509_cert_url: process.env.GOOGLE_CLIENT_CERT_URL,
  universe_domain: process.env.GOOGLE_UNIVERSE_DOMAIN,
};

/* ===== Autenticação Google ===== */
const auth = new google.auth.GoogleAuth({
  credentials,
  scopes: ['https://www.googleapis.com/auth/calendar'],
});
const calendar = google.calendar({ version: 'v3', auth });

/* ===== App ===== */
// === Email (Resend) ===
const resend = new Resend(process.env.RESEND_API_KEY);

// html simples para o email
function confirmationHtml({
  customerName,
  date,
  time,
  serviceName,
  barberName,
  isFamily,
  secondPersonName,
}) {
  return `
    <div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#111;line-height:1.5">
      <h2>Confirmação de Marcação</h2>
      <p>Olá <strong>${customerName}</strong>,</p>
      <p>A sua marcação foi confirmada:</p>
      <ul>
        <li><strong>Data:</strong> ${date}</li>
        <li><strong>Hora:</strong> ${time}</li>
        <li><strong>Serviço:</strong> ${serviceName}</li>
        <li><strong>Barbeiro:</strong> ${barberName}</li>
      </ul>
      ${isFamily ? `<p><strong>Marcação Dupla/Familiar</strong><br/>2.º Cliente: ${secondPersonName || '—'}</p>` : ''}
      <p>Se precisar de alterar ou cancelar, responda a este e-mail.</p>
      <p>Obrigado,<br/>MHM Studio</p>
    </div>
  `;
}

const app = express();
app.use(cors());
app.use(express.json());

/* ===== Helpers ===== */
const CALENDAR_ID = 'mhmhairstudio@gmail.com';
const TIMEZONE = 'Europe/Lisbon';

const barbeiroColors = {
  'Cláudio Monteiro': '7',
  'André Henriques (CC)': '11',
};

/**
 * Helper para criar um evento no Google Calendar e verificar o resultado.
 * @param {object} eventBody - O corpo do evento a ser inserido.
 */
async function createCalendarEvent(eventBody) {
  const response = await calendar.events.insert({
    calendarId: CALENDAR_ID,
    requestBody: eventBody,
    fields: 'id,htmlLink,iCalUID',
  });
  
  const { id, htmlLink, iCalUID } = response.data || {};
  if (!id) {
    console.error('Evento criado mas sem ID no payload:', response.data);
    throw new Error('Evento criado mas sem ID retornado pelo Google.');
  }

  return { id, htmlLink, iCalUID, data: response.data };
}

/* ===== Rota de saúde/raiz ===== */
app.get('/', (_req, res) => {
  res.send('Servidor do MHMSTUDIO está ativo 🚀');
});
app.get('/health', (_req, res) => res.json({ ok: true }));

/* ===== Criar evento (marcação) (CORRIGIDO) ===== */
app.post('/adicionar-evento', async (req, res) => {
  const {
    nome, numero, servico, barbeiro, data, hora,
    summary, description, start, end,
    durationMinutes, // 30 ou 60 (default 60)
    bookingType,     // Tipos de marcação: individual | familiar
    secondPersonInfo, // Informações do segundo cliente (para marcações familiares)
    secondPersonBarber, // Barbeiro do segundo cliente
    toEmail,          // Email do cliente para enviar a confirmação
  } = req.body;

  try {
    // Array para guardar os resultados de todos os eventos criados (1 ou 2)
    const createdEvents = [];

    // 1. Caso de uso: Dados completos passados (ex: eventos internos/ausências que usam summary/start/end)
    if (summary && description && start && end) {
      const match = description.match(/Barbeiro:\s*(.+)/i);
      const nomeDoBarbeiro = match ? match[1].trim() : null;

      const evento = {
        summary,
        description,
        start,
        end,
        colorId: nomeDoBarbeiro ? barbeiroColors[nomeDoBarbeiro] : undefined,
      };

      const response = await createCalendarEvent(evento);
      createdEvents.push(response);
      console.log('✅ Evento criado com dados completos:', response.id);
    
    // 2. Caso de uso: Marcação de cliente (Individual ou Familiar)
    } else if (nome && servico && barbeiro && data && hora) {
      const minutes = Number(durationMinutes) || 60;
      const startTime = DateTime.fromISO(`${data}T${hora}`, { zone: TIMEZONE });
      const endTime = startTime.plus({ minutes });
      
      // Estrutura de tempo base para reutilização
      const timeData = { 
        start: { dateTime: startTime.toISO(), timeZone: TIMEZONE }, 
        end:   { dateTime: endTime.toISO(),   timeZone: TIMEZONE }, 
      };

      // --- Evento do PRIMEIRO CLIENTE ---
      const firstEvento = {
        summary: `${nome} - ${numero ? `${numero} - ` : ''}${servico}`,
        description: `Barbeiro: ${barbeiro}`,
        colorId: barbeiroColors[barbeiro],
        ...timeData, 
      };

      const firstResponse = await createCalendarEvent(firstEvento);
      createdEvents.push(firstResponse);
      console.log('✅ Evento do primeiro cliente criado:', firstResponse.id);
      
      // --- Lógica para Marcação FAMILIAR ---
      if (bookingType === 'familiar' && secondPersonInfo && secondPersonBarber) {
        console.log('Criando segundo evento para marcação familiar...');
        
        const secondEvento = {
          summary: `${secondPersonInfo.name} - ${secondPersonInfo.phone ? `${secondPersonInfo.phone} - ` : ''}${servico}`,
          description: `Barbeiro: ${secondPersonBarber}`,
          colorId: barbeiroColors[secondPersonBarber], // Usa a cor do segundo barbeiro
          ...timeData, // Usa o mesmo horário e duração do primeiro
        };

        const secondResponse = await createCalendarEvent(secondEvento);
        createdEvents.push(secondResponse);
        console.log('✅ Evento do segundo cliente criado:', secondResponse.id);
      }

    } else {
      return res.status(400).json({ error: 'Dados em falta para criar o evento.' });
    }
    
    // O evento principal é sempre o primeiro evento criado, seja individual ou familiar
    const mainEvent = createdEvents[0];

    // Enviar o e-mail de confirmação para o cliente
    const subject = `Confirmação: ${data} às ${hora} — ${servico}`;
    const emailSent = await resend.emails.send({
      from: 'MHM Studio <no-reply@mhmstudio.pt>',
      to: [toEmail], // Enviar para o e-mail do cliente
      subject,
      html: confirmationHtml({
        customerName: nome,
        date: data,
        time: hora,
        serviceName: servico,
        barberName: barbeiro,
        isFamily: bookingType === 'familiar',
        secondPersonName: secondPersonInfo ? secondPersonInfo.name : '',
      }),
    });

    console.log('Enviando e-mail para:', toEmail);

    if (emailSent.error) {
      console.error('Erro ao enviar e-mail:', emailSent.error || emailSent);
      return res.status(500).json({ ok: false, message: 'Falha ao enviar o e-mail.' });
    }

    console.log('✅ E-mail de confirmação enviado');

    // Normalização + compat: devolvemos o ID principal e, opcionalmente, todos os IDs
    return res.status(200).json({
      success: true,
      id: mainEvent.id,
      iddamarcacao: mainEvent.id,      // compat com o teu frontend atual
      iCalUID: mainEvent.iCalUID,
      eventLink: mainEvent.htmlLink,
      createdEvents: createdEvents.map(e => ({ id: e.id, iCalUID: e.iCalUID, link: e.htmlLink })), 
    });

  } catch (error) {
    console.error('❌ Erro ao criar evento:', error.message || error?.response?.data || error);
    return res.status(500).json({ error: 'Erro ao criar evento no Google Calendar' });
  }
});

/* ===== Remover evento (compatível id/iddamarcacao) ===== */
app.post('/remover-evento', async (req, res) => {
  try {
    // Se estiver a usar a funcionalidade de "createdEvents" do novo endpoint, 
    // podes enviar um array de IDs para remover múltiplos eventos de uma vez.
    const idsToRemove = Array.isArray(req.body.id) 
      ? req.body.id 
      : [req.body.id || req.body.iddamarcacao].filter(Boolean);

    if (idsToRemove.length === 0) {
      return res.status(400).json({ error: 'Falta o(s) id(s) do evento Google Calendar' });
    }

    const results = await Promise.all(idsToRemove.map(id => 
      calendar.events.delete({
        calendarId: CALENDAR_ID,
        eventId: id,
      })
    ));
    
    console.log(`✅ ${idsToRemove.length} evento(s) removido(s)`);

    return res.json({ success: true, removedCount: idsToRemove.length });
  } catch (error) {
    console.error('Erro ao remover evento do Google Calendar:', error?.response?.data || error);
    return res.status(500).json({ error: 'Erro ao remover evento do Google Calendar' });
  }
});

/* ===== Adicionar ausência ===== */
app.post('/adicionar-ausencia', async (req, res) => {
  try {
    const { nome, dataInicio, dataFim, hora } = req.body;

    if (!nome || !dataInicio) {
      return res.status(400).json({ error: 'Dados insuficientes' });
    }

    let evento;

    if (hora) {
      // Ausência pontual (com hora específica) - Duração de 30 minutos por omissão
      const startDT = DateTime.fromISO(`${dataInicio}T${hora}`, { zone: TIMEZONE });
      const endDT = startDT.plus({ minutes: 30 });

      evento = {
        summary: `Ausência - ${nome}`,
        description: `Ausência do barbeiro ${nome}`,
        start: { dateTime: startDT.toISO(), timeZone: TIMEZONE },
        end:   { dateTime: endDT.toISO(),   timeZone: TIMEZONE },
        colorId: '8', // Cor laranja/castanha (muito usada para ausências)
        transparency: 'opaque', // Marcar como ocupado
      };
    } else {
      // Ausência de dia inteiro (all-day event)
      const startDate = DateTime.fromISO(`${dataInicio}`, { zone: TIMEZONE }).startOf('day');
      // Para eventos de dia inteiro, a data de fim deve ser o dia *seguinte*
      const endBase = DateTime.fromISO(`${dataFim || dataInicio}`, { zone: TIMEZONE }).startOf('day');
      const endDate = endBase.plus({ days: 1 });

      evento = {
        summary: `Ausência - ${nome}`,
        description: `Ausência do barbeiro ${nome}`,
        start: { date: startDate.toISODate() },
        end:   { date: endDate.toISODate() },
        colorId: '8',
        transparency: 'opaque',
      };
    }

    const response = await createCalendarEvent(evento);

    console.log('✅ Ausência criada:', response.id);

    return res.status(200).json({
      success: true,
      id: response.id,
      idAusencia: response.id,        // compat opcional
      iCalUID: response.iCalUID,
      eventLink: response.htmlLink,
    });
  } catch (error) {
    console.error('❌ Erro ao adicionar ausência:', error?.response?.data || error);
    return res.status(500).json({ error: 'Erro ao adicionar ausência ao Google Calendar' });
  }
});

/* ===== Remover ausência (compatível id/idAusencia) ===== */
app.post('/remover-ausencia', async (req, res) => {
  try {
    const id = req.body.id || req.body.idAusencia;
    if (!id) {
      return res.status(400).json({ error: 'Falta o id da ausência do Google Calendar' });
    }

    await calendar.events.delete({
      calendarId: CALENDAR_ID,
      eventId: id,
    });

    return res.json({ success: true });
  } catch (error) {
    console.error('Erro ao remover ausência do Google Calendar:', error?.response?.data || error);
    return res.status(500).json({ error: 'Erro ao remover ausência do Google Calendar' });
  }
});

/* ===== Start server ===== */
const PORT = process.env.PORT || 8085;
app.listen(PORT, () => {
  console.log(`🚀 Servidor a correr na porta ${PORT}`);
});