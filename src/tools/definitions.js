// Tool definitions for Claude tool_use
export const TOOL_DEFINITIONS = [
  // === GOOGLE CALENDAR ===
  {
    name: 'calendar_list_events',
    description: 'List upcoming events from Google Calendar. Returns events for the specified number of days ahead.',
    input_schema: {
      type: 'object',
      properties: {
        days_ahead: {
          type: 'number',
          description: 'Number of days to look ahead. Default 7.',
        },
        query: {
          type: 'string',
          description: 'Optional search query to filter events.',
        },
      },
      required: [],
    },
  },
  {
    name: 'calendar_create_event',
    description: 'Create a new Google Calendar event.',
    input_schema: {
      type: 'object',
      properties: {
        summary: {
          type: 'string',
          description: 'Event title.',
        },
        start: {
          type: 'string',
          description: 'Start datetime in ISO 8601 format (e.g., 2026-03-15T10:00:00). Use Europe/London timezone.',
        },
        end: {
          type: 'string',
          description: 'End datetime in ISO 8601 format. If not provided, defaults to 1 hour after start.',
        },
        description: {
          type: 'string',
          description: 'Optional event description.',
        },
        location: {
          type: 'string',
          description: 'Optional event location.',
        },
      },
      required: ['summary', 'start'],
    },
  },
  {
    name: 'calendar_update_event',
    description: 'Update an existing Google Calendar event. Use calendar_list_events first to get the event ID.',
    input_schema: {
      type: 'object',
      properties: {
        event_id: {
          type: 'string',
          description: 'The event ID from calendar_list_events.',
        },
        summary: {
          type: 'string',
          description: 'New event title (optional — only include to change).',
        },
        start: {
          type: 'string',
          description: 'New start date/time. Use YYYY-MM-DD for all-day or ISO 8601 for timed events.',
        },
        end: {
          type: 'string',
          description: 'New end date/time. For all-day events, use the day AFTER the last day (Google Calendar exclusive end).',
        },
        description: {
          type: 'string',
          description: 'New event description.',
        },
        location: {
          type: 'string',
          description: 'New event location.',
        },
      },
      required: ['event_id'],
    },
  },
  {
    name: 'calendar_find_free_time',
    description: 'Check calendar availability for a specific date or date range.',
    input_schema: {
      type: 'object',
      properties: {
        date: {
          type: 'string',
          description: 'Date to check in YYYY-MM-DD format.',
        },
        days: {
          type: 'number',
          description: 'Number of days to check. Default 1.',
        },
      },
      required: ['date'],
    },
  },

  // === GMAIL ===
  {
    name: 'gmail_search',
    description: 'Search Gmail inbox. Returns message summaries.',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Gmail search query (same syntax as Gmail search bar). E.g., "from:john subject:meeting is:unread"',
        },
        max_results: {
          type: 'number',
          description: 'Max results to return. Default 10.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'gmail_read',
    description: 'Read the full content of a specific email by ID.',
    input_schema: {
      type: 'object',
      properties: {
        message_id: {
          type: 'string',
          description: 'The Gmail message ID to read.',
        },
      },
      required: ['message_id'],
    },
  },
  {
    name: 'gmail_draft',
    description: 'Create a draft email (does NOT send). Always use this first — James must confirm before sending. Returns draft ID and preview.',
    input_schema: {
      type: 'object',
      properties: {
        to: {
          type: 'string',
          description: 'Recipient email address.',
        },
        subject: {
          type: 'string',
          description: 'Email subject line.',
        },
        body: {
          type: 'string',
          description: 'Email body text.',
        },
        thread_id: {
          type: 'string',
          description: 'Optional thread ID to reply to an existing conversation.',
        },
      },
      required: ['to', 'subject', 'body'],
    },
  },
  {
    name: 'gmail_confirm_send',
    description: 'Send an existing draft email. ONLY call this after James has explicitly confirmed he wants the draft sent. Requires the draft ID from gmail_draft.',
    input_schema: {
      type: 'object',
      properties: {
        draft_id: {
          type: 'string',
          description: 'The draft ID returned by gmail_draft.',
        },
      },
      required: ['draft_id'],
    },
  },

  // === LIVE TRAVEL DATA ===
  {
    name: 'train_departures',
    description: 'Get live train departure board from National Rail Darwin. Shows next trains, platforms, delays, and cancellations. Use for "when\'s the next train to York?" or "any delays at Kings Cross?"',
    input_schema: {
      type: 'object',
      properties: {
        from: {
          type: 'string',
          description: 'Departure station CRS code (e.g., "KGX" for Kings Cross, "YRK" for York, "LDS" for Leeds).',
        },
        to: {
          type: 'string',
          description: 'Optional destination CRS code to filter departures.',
        },
      },
      required: ['from'],
    },
  },
  {
    name: 'train_fares',
    description: 'Get actual ticket prices for a rail journey. Shows Advance, Off-Peak, and Anytime fares. Use for "how much are tickets to York?" or "cheapest train fare Kings Cross to York".',
    input_schema: {
      type: 'object',
      properties: {
        from: {
          type: 'string',
          description: 'Origin station CRS code (e.g., "KGX").',
        },
        to: {
          type: 'string',
          description: 'Destination station CRS code (e.g., "YRK").',
        },
      },
      required: ['from', 'to'],
    },
  },
  {
    name: 'hotel_search',
    description: 'Search for hotels with real-time prices and availability via Amadeus. Supports search by coordinates or area name (e.g., "north_york_moors", "helmsley", "york"). Use for "find a hotel near Helmsley for this weekend".',
    input_schema: {
      type: 'object',
      properties: {
        area: {
          type: 'string',
          description: 'Named area: "north_york_moors", "york", "helmsley", "pickering", "whitby", "malton", "scarborough". Resolves to coordinates automatically.',
        },
        latitude: {
          type: 'number',
          description: 'Latitude for custom location search. Overrides area.',
        },
        longitude: {
          type: 'number',
          description: 'Longitude for custom location search. Overrides area.',
        },
        checkin: {
          type: 'string',
          description: 'Check-in date YYYY-MM-DD.',
        },
        checkout: {
          type: 'string',
          description: 'Check-out date YYYY-MM-DD.',
        },
        adults: {
          type: 'number',
          description: 'Number of adults. Default 2.',
        },
        radius: {
          type: 'number',
          description: 'Search radius in km. Default 30.',
        },
      },
      required: ['checkin', 'checkout'],
    },
  },

  // === TRAVEL BOOKING LINKS ===
  {
    name: 'search_trains',
    description: 'Search for train tickets (LNER, National Rail). Supports single journeys, returns, and multi-leg weekend trips. For James\'s York visits, use legs for complex patterns (e.g. 4-trip weekends).',
    input_schema: {
      type: 'object',
      properties: {
        from: {
          type: 'string',
          description: 'Departure station (e.g., "London Kings Cross", "York"). Used for single/return journeys or as default for legs.',
        },
        to: {
          type: 'string',
          description: 'Arrival station. Used for single/return journeys or as default for legs.',
        },
        date: {
          type: 'string',
          description: 'Travel date YYYY-MM-DD. Used for single journey or as default for legs.',
        },
        time: {
          type: 'string',
          description: 'Preferred departure time (e.g., "18:00"). Used for single journey or as default for legs.',
        },
        return_date: {
          type: 'string',
          description: 'Return date for simple return tickets.',
        },
        legs: {
          type: 'array',
          description: 'For multi-leg trips (e.g. 4-trip weekends). Each leg has from, to, date, and optional time. Overrides single journey params.',
          items: {
            type: 'object',
            properties: {
              from: { type: 'string', description: 'Departure station for this leg.' },
              to: { type: 'string', description: 'Arrival station for this leg.' },
              date: { type: 'string', description: 'Date YYYY-MM-DD for this leg.' },
              time: { type: 'string', description: 'Preferred time for this leg.' },
            },
            required: ['from', 'to', 'date'],
          },
        },
      },
      required: ['from', 'to', 'date'],
    },
  },
  {
    name: 'search_accommodation',
    description: 'Search for accommodation. Has special North York Moors support — use area="north_york_moors" or mention "moors" in location for NYM-specific results with local area knowledge.',
    input_schema: {
      type: 'object',
      properties: {
        location: {
          type: 'string',
          description: 'Destination (e.g., "Helmsley, North Yorkshire", "North York Moors", "Pickering")',
        },
        checkin: {
          type: 'string',
          description: 'Check-in date YYYY-MM-DD',
        },
        checkout: {
          type: 'string',
          description: 'Check-out date YYYY-MM-DD',
        },
        guests: {
          type: 'number',
          description: 'Number of guests. Default 2.',
        },
        budget: {
          type: 'string',
          description: 'Budget preference: "budget", "mid", "luxury"',
        },
        area: {
          type: 'string',
          description: 'Special area flag. Use "north_york_moors" for NYM-specific results with local village suggestions and rural stays.',
        },
      },
      required: ['location', 'checkin', 'checkout'],
    },
  },
  // === WEB SEARCH ===
  {
    name: 'web_search',
    description: 'Search the web for current information. Use when you need facts, prices, contact details, news, or anything outside your training data. Returns titles, URLs, and snippets.',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query.',
        },
        count: {
          type: 'number',
          description: 'Number of results (1-10). Default 5.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'web_fetch',
    description: 'Fetch and read the content of a URL. Use after web_search to read full page content, or when someone shares a link. Extracts main article content, preserves headings/lists/links as readable text. Max 8000 chars.',
    input_schema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The full URL to fetch.',
        },
      },
      required: ['url'],
    },
  },

  // === TODOS & REMINDERS ===
  {
    name: 'todo_add',
    description: 'Add a new todo item. Can optionally set a due date and a reminder time (sends WhatsApp notification).',
    input_schema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The todo item text.' },
        due_date: { type: 'string', description: 'Optional due date YYYY-MM-DD.' },
        reminder: { type: 'string', description: 'Optional ISO datetime for WhatsApp reminder (e.g., "2026-03-15T09:00:00"). Will send a WhatsApp message at this time.' },
        priority: { type: 'string', description: 'Priority: "low", "normal", or "high". Default "normal".' },
      },
      required: ['text'],
    },
  },
  {
    name: 'todo_list',
    description: 'List todo items. By default shows only active (not done) items.',
    input_schema: {
      type: 'object',
      properties: {
        show_done: { type: 'boolean', description: 'Include completed items. Default false.' },
        priority: { type: 'string', description: 'Filter by priority: "low", "normal", "high".' },
      },
      required: [],
    },
  },
  {
    name: 'todo_complete',
    description: 'Mark a todo item as completed.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The todo item ID.' },
      },
      required: ['id'],
    },
  },
  {
    name: 'todo_remove',
    description: 'Delete a todo item entirely.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The todo item ID.' },
      },
      required: ['id'],
    },
  },
  {
    name: 'todo_update',
    description: 'Update an existing todo item (text, due date, reminder, or priority).',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The todo item ID.' },
        text: { type: 'string', description: 'New text for the item.' },
        due_date: { type: 'string', description: 'New due date YYYY-MM-DD (or empty string to clear).' },
        reminder: { type: 'string', description: 'New reminder datetime ISO (or empty string to clear).' },
        priority: { type: 'string', description: 'New priority: "low", "normal", "high".' },
      },
      required: ['id'],
    },
  },

  // === SOUL SYSTEM (Self-Recode) ===
  {
    name: 'soul_read',
    description: 'Read your soul — what you have learned from interactions. Sections: people (facts about individuals), patterns (observed habits), lessons (incidents that changed behaviour), boundaries (social rules from feedback). Always safe to call.',
    input_schema: {
      type: 'object',
      properties: {
        section: {
          type: 'string',
          description: 'Optional: specific section (people, patterns, lessons, boundaries). Omit to read all.',
        },
      },
      required: [],
    },
  },
  {
    name: 'soul_learn',
    description: 'Add a learned entry to your soul. Use when you notice something about a person, a pattern in how James works, or a lesson from an interaction. This writes directly — no confirmation needed.',
    input_schema: {
      type: 'object',
      properties: {
        section: {
          type: 'string',
          description: 'Section: people, patterns, lessons, or boundaries.',
        },
        text: {
          type: 'string',
          description: 'What you learned (max 200 chars). Be specific and concise.',
        },
      },
      required: ['section', 'text'],
    },
  },
  {
    name: 'soul_forget',
    description: 'Remove a learned entry from your soul by section and index number. Owner-only.',
    input_schema: {
      type: 'object',
      properties: {
        section: {
          type: 'string',
          description: 'Section: people, patterns, lessons, or boundaries.',
        },
        index: {
          type: 'number',
          description: 'Entry number to remove (1-based, as shown by soul_read).',
        },
      },
      required: ['section', 'index'],
    },
  },
  {
    name: 'soul_propose',
    description: 'Propose a soul update for James to review. Stores a pending change that must be confirmed via soul_confirm. Use when you observe something worth learning but want owner approval first. In groups, proposals are always sent to James via DM.',
    input_schema: {
      type: 'object',
      properties: {
        section: { type: 'string' },
        content: { type: 'string' },
        reason: { type: 'string' },
      },
      required: ['section', 'content', 'reason'],
    },
  },
  {
    name: 'soul_confirm',
    description: 'Confirm and apply the pending soul proposal. Only works from owner DM. Call this after James has reviewed and approved a soul_propose.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },

  // === MEMORY ===
  {
    name: 'memory_search',
    description: 'Search your long-term memory for relevant facts. Use when James asks about something you might have stored previously, or when you need context for a travel, legal, accommodation, or personal task.',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Natural language search query.',
        },
        category: {
          type: 'string',
          description: 'Optional category filter: preference, person, legal, travel, accommodation, henry, ai_consultancy, schedule, general.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'memory_update',
    description: 'Correct an incorrect memory. Use when James says something like "that\'s wrong" about a stored fact. Search first to find the memory ID, then update it.',
    input_schema: {
      type: 'object',
      properties: {
        memory_id: {
          type: 'string',
          description: 'The memory ID to update.',
        },
        fact: {
          type: 'string',
          description: 'Corrected fact text.',
        },
        category: {
          type: 'string',
          description: 'Updated category if needed.',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Updated tags if needed.',
        },
      },
      required: ['memory_id'],
    },
  },
  {
    name: 'memory_delete',
    description: 'Delete a memory that is wrong or no longer relevant.',
    input_schema: {
      type: 'object',
      properties: {
        memory_id: {
          type: 'string',
          description: 'The memory ID to delete.',
        },
      },
      required: ['memory_id'],
    },
  },
  {
    name: 'system_status',
    description: 'Get the current status of the Clawd system — uptime, memory, WhatsApp connection, EVO X2 health.',
    input_schema: {
      type: 'object',
      properties: {},
    },
  },

  // === PROJECTS ===
  {
    name: 'project_list',
    description: 'List all defined projects with their names, status, and one-liners.',
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'project_read',
    description: 'Read a project\'s full details or a specific section. Use to recall project architecture, pitch points, next steps, etc. Available projects: atlas (ATLAS — litigation AI), clawd-agi (Clawd AGI — recursive self-improving intelligence).',
    input_schema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'Project ID (e.g., "atlas").',
        },
        section: {
          type: 'string',
          description: 'Optional: specific section to read (summary, architecture, keyDifferentiators, potentialPartners, nextSteps, foundingInsight, tags). Omit to read everything.',
        },
      },
      required: ['id'],
    },
  },
  {
    name: 'project_pitch',
    description: 'Generate a pitch for a project tailored to a specific audience. Returns structured context for you to deliver a compelling pitch.',
    input_schema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'Project ID (e.g., "atlas").',
        },
        audience: {
          type: 'string',
          description: 'Who the pitch is for — e.g., "Shlomo Klapper (Learned Hand founder)", "VC investor", "BigLaw managing partner", "legal tech conference".',
        },
      },
      required: ['id'],
    },
  },
  {
    name: 'project_update',
    description: 'Update a project field. Can update status, summary, oneLiner, foundingInsight directly, or append items to nextSteps, tags, or keyDifferentiators arrays.',
    input_schema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'Project ID.',
        },
        field: {
          type: 'string',
          description: 'Field to update: status, summary, oneLiner, foundingInsight, nextSteps, tags, keyDifferentiators.',
        },
        value: {
          type: 'string',
          description: 'The new value (for string fields) or item to append (for array fields).',
        },
      },
      required: ['id', 'field', 'value'],
    },
  },

  // === OVERNIGHT REPORT ===
  {
    name: 'overnight_report',
    description: 'Regenerate and send the overnight intelligence report (diary summaries, facts, insights, soul observations, project deep think, self-improvement, system health). Sends via email and WhatsApp. Use when James asks to regenerate, resend, or review the overnight report.',
    input_schema: {
      type: 'object',
      properties: {
        date: {
          type: 'string',
          description: 'Optional date to generate report for (YYYY-MM-DD). Defaults to yesterday.',
        },
      },
      required: [],
    },
  },

  // === EVOLUTION ===
  {
    name: 'evolution_task',
    description: 'Create a coding task for autonomous execution. Clawd will run Claude Code CLI on EVO to make the change in a git branch, then send the diff to James for approval before deploying. Use when James asks to fix, change, add, or improve Clawd\'s own code.',
    input_schema: {
      type: 'object',
      properties: {
        instruction: {
          type: 'string',
          description: 'What code change to make. Be specific about the file, function, or behaviour to change.',
        },
        priority: {
          type: 'string',
          enum: ['normal', 'high'],
          description: 'Priority level. High = processed next, normal = queued.',
        },
      },
      required: ['instruction'],
    },
  },

  // === FILE SENDING ===
  {
    name: 'send_file',
    description: 'Send a file from the data/ directory as a WhatsApp document attachment. Use when asked to send, share, or forward a document, PDF, or file to the chat.',
    input_schema: {
      type: 'object',
      properties: {
        filename: {
          type: 'string',
          description: 'Filename within data/ directory (e.g. "refactoring-vibe-coded-projects.pdf")',
        },
        caption: {
          type: 'string',
          description: 'Optional caption to send with the document.',
        },
      },
      required: ['filename'],
    },
  },

  // === GROUP CONTENT RESTRICTIONS ===
  {
    name: 'group_restrict',
    description: 'Set content restrictions for the current WhatsApp group. Blocks specific topics from being discussed. Owner only. Use when James says to block or restrict topics in a group.',
    input_schema: {
      type: 'object',
      properties: {
        label: {
          type: 'string',
          description: 'Human-readable label for this group (e.g. "AGI (Tom Glover)").',
        },
        blocked_topics: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of topics that must never be discussed in this group.',
        },
        confidentiality_prompt: {
          type: 'string',
          description: 'Optional free-form confidentiality instruction for this group.',
        },
      },
      required: ['label'],
    },
  },
  {
    name: 'group_unrestrict',
    description: 'Remove all content restrictions from the current WhatsApp group. Owner only.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'group_restrictions',
    description: 'Show current content restrictions for this group, if any.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
];
