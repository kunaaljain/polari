const Gdk = imports.gi.Gdk;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;
const Polari = imports.gi.Polari;
const Tp = imports.gi.TelepathyGLib;

const AccountsMonitor = imports.accountsMonitor;
const AppNotifications = imports.appNotifications;
const JoinDialog = imports.joinDialog;
const Lang = imports.lang;
const Mainloop = imports.mainloop;
const RoomList = imports.roomList;
const RoomStack = imports.roomStack;
const UserList = imports.userList;
const Utils = imports.utils;

const CONFIGURE_TIMEOUT = 100; /* ms */


const FixedSizeFrame = new Lang.Class({
    Name: 'FixedSizeFrame',
    Extends: Gtk.Frame,
    Properties: {
        height: GObject.ParamSpec.int('height',
                                      'height',
                                      'height',
                                      GObject.ParamFlags.READWRITE,
                                      -1, GLib.MAXINT32, -1),
        width: GObject.ParamSpec.int('width',
                                     'width',
                                     'width',
                                     GObject.ParamFlags.READWRITE,
                                     -1, GLib.MAXINT32, -1)
    },

    _init: function(params) {
        this._height = -1;
        this._width = -1;

        this.parent(params);
    },

    _queueRedraw: function() {
        let child = this.get_child();
        if (child)
            child.queue_resize();
        this.queue_draw();
    },

    get height() {
        return this._height;
    },

    set height(height) {
        if (height == this._height)
            return;
        this._height = height;
        this.notify('height');
        this.set_size_request(this._width, this._height);
        this._queueRedraw();
    },

    get width() {
        return this._width;
    },

    set width(width) {
        if (width == this._width)
            return;

        this._width = width;
        this.notify('width');
        this.set_size_request(this._width, this._height);
        this._queueRedraw();
    },

    vfunc_get_preferred_width_for_height: function(forHeight) {
        let [min, nat] = this.parent(forHeight);
        return [min, this._width < 0 ? nat : this._width];
    },

    vfunc_get_preferred_height_for_width: function(forWidth) {
        let [min, nat] = this.parent(forWidth);
        return [min, this._height < 0 ? nat : this._height];
    }
});

const MainWindow = new Lang.Class({
    Name: 'MainWindow',
    Extends: Gtk.ApplicationWindow,
    Template: 'resource:///org/gnome/Polari/ui/main-window.ui',
    InternalChildren: ['titlebarRight',
                       'titlebarLeft',
                       'joinButton',
                       'showUserListButton',
                       'userListPopover',
                       'roomListRevealer',
                       'overlay',
                       'roomStack'],
    Properties: {
        subtitle: GObject.ParamSpec.string('subtitle',
                                           'subtitle',
                                           'subtitle',
                                           GObject.ParamFlags.READABLE,
                                           ''),
        'subtitle-visible': GObject.ParamSpec.boolean('subtitle-visible',
                                                      'subtitle-visible',
                                                      'subtitle-visible',
                                                      GObject.ParamFlags.READABLE,
                                                      false),
        'active-room': GObject.ParamSpec.object('active-room',
                                                'active-room',
                                                'active-room',
                                                GObject.ParamFlags.READWRITE,
                                                Polari.Room.$gtype),
        'active-room-id': GObject.ParamSpec.string('active-room-id',
                                                   'active-room-id',
                                                   'active-room-id',
                                                   GObject.ParamFlags.READABLE,
                                                   ''),
        'single-room': GObject.ParamSpec.boolean('single-room',
                                                 'single-room',
                                                 'single-room',
                                                 GObject.ParamFlags.READWRITE |
                                                 GObject.ParamFlags.CONSTRUCT_ONLY,
                                                 false)
    },
    Signals: { 'active-room-state-changed': {} },

    _init: function(params) {
        this._subtitle = '';
        params.show_menubar = false;

        this._room = null;
        this._singleRoom = false;

        this._displayNameChangedId = 0;
        this._topicChangedId = 0;
        this._membersChangedId = 0;

        this.parent(params);

        this._addApplicationStyle();

        this._settings = new Gio.Settings({ schema_id: 'org.gnome.Polari' });
        this._gtkSettings = Gtk.Settings.get_default();

        this._currentSize = [-1, -1];
        this._isMaximized = false;
        this._isFullscreen = false;

        this.notificationQueue = new AppNotifications.NotificationQueue();
        this._overlay.add_overlay(this.notificationQueue);

        this.commandOutputQueue = new AppNotifications.CommandOutputQueue();
        this._overlay.add_overlay(this.commandOutputQueue);

        // command output notifications should not pop up over
        // the input area, but appear to emerge from it, so
        // set up an appropriate margin
        this._roomStack.bind_property('entry-area-height',
                                      this.commandOutputQueue, 'margin-bottom',
                                      GObject.BindingFlags.SYNC_CREATE);

        // Make sure user-list button is at least as wide as icon buttons
        this._joinButton.connect('size-allocate', Lang.bind(this,
            function(w, rect) {
                let width = rect.width;
                Mainloop.idle_add(Lang.bind(this, function() {
                    this._showUserListButton.width_request = width;
                    return GLib.SOURCE_REMOVE;
                }));
            }));

        this._accountsMonitor = AccountsMonitor.getDefault();
        this._accountsMonitor.connect('accounts-changed',
                                      Lang.bind(this, this._onAccountsChanged));
        this._onAccountsChanged(this._accountsMonitor);

        this._updateUserListLabel();

        let actionEntries = [
          { name: 'show-join-dialog',
            activate: Lang.bind(this, this._onShowJoinDialog),
            accels: ['<Primary>n'] },
          { name: 'leave-current-room',
            activate: Lang.bind(this, this._onLeaveCurrentRoom),
            create_hook: Lang.bind(this, this._leaveRoomCreateHook),
            accels: ['<Primary>w'] },
          { name: 'user-list',
            activate: Lang.bind(this, this._onToggleAction),
            create_hook: Lang.bind(this, this._userListCreateHook),
            state: GLib.Variant.new('b', false),
            accels: ['F9', '<Primary>u'] },
          { name: 'next-room',
            create_hook: Lang.bind(this, this._roomNavCreateHook),
            accels: ['<Primary>Page_Down', '<Alt>Down'] },
          { name: 'previous-room',
            create_hook: Lang.bind(this, this._roomNavCreateHook),
            accels: ['<Primary>Page_Up', '<Alt>Up'] },
          { name: 'first-room',
            create_hook: Lang.bind(this, this._roomNavCreateHook),
            accels: ['<Primary>Home'] },
          { name: 'last-room',
            create_hook: Lang.bind(this, this._roomNavCreateHook),
            accels: ['<Primary>End'] },
          { name: 'nth-room',
            create_hook: Lang.bind(this, this._roomNavCreateHook),
            parameter_type: GLib.VariantType.new('i') },
          { name: 'next-pending-room',
            create_hook: Lang.bind(this, this._roomNavCreateHook),
            accels: ['<Alt><Shift>Down', '<Primary><Shift>Page_Down']},
          { name: 'previous-pending-room',
            create_hook: Lang.bind(this, this._roomNavCreateHook),
            accels: ['<Alt><Shift>Up', '<Primary><Shift>Page_Up']}
        ];
        Utils.addActionEntries(this, 'win', actionEntries);

        let action = this.lookup_action('user-list');
        this.connect('action-state-changed::user-list', (w, name, value) => {
            this._userListPopover.visible = value.get_boolean();
        });
        this._userListPopover.connect('notify::visible', () => {
            if (!this._userListPopover.visible)
                action.change_state(GLib.Variant.new('b', false));
        });

        this._gtkSettings.connect('notify::gtk-decoration-layout',
                                  Lang.bind(this, this._updateDecorations));
        this._updateDecorations();

        this.connect('window-state-event',
                            Lang.bind(this, this._onWindowStateEvent));
        this.connect('size-allocate',
                            Lang.bind(this, this._onSizeAllocate));
        this.connect('delete-event',
                            Lang.bind(this, this._onDelete));
        this.connect('notify::active-room', () => {
            this._updateUserListLabel();
        });

        let size = this._settings.get_value('window-size').deep_unpack();
        if (size.length == 2)
            this.set_default_size.apply(this, size);

        if (this._settings.get_boolean('window-maximized'))
            this.maximize();
    },

    get subtitle() {
        return this._subtitle;
    },

    get subtitle_visible() {
        return this._subtitle.length > 0;
    },

    get single_room() {
        return this._singleRoom;
    },

    set single_room(value) {
        if (this._singleRoom == value)
            return;

        this._singleRoom = value;
        this.notify('single-room');
    },

    _onWindowStateEvent: function(widget, event) {
        let state = event.get_window().get_state();

        this._isFullscreen = (state & Gdk.WindowState.FULLSCREEN) != 0;
        this._isMaximized = (state & Gdk.WindowState.MAXIMIZED) != 0;
    },

    _onSizeAllocate: function(widget, allocation) {
        if (!this._isFullscreen && !this._isMaximized)
            this._currentSize = this.get_size(this);
    },

    _onDelete: function(widget, event) {
        this._settings.set_boolean ('window-maximized', this._isMaximized);
        this._settings.set_value('window-size',
                                 GLib.Variant.new('ai', this._currentSize));
    },

    _onAccountsChanged: function(am) {
        let hasAccounts = am.dupAccounts().some(a => a.enabled);
        this._roomListRevealer.reveal_child = !this._singleRoom && hasAccounts;
    },

    _updateDecorations: function() {
        let layoutLeft = null;
        let layoutRight = null;

        let layout = this._gtkSettings.gtk_decoration_layout;
        if (layout) {
            let split = layout.split(':');

            layoutLeft = split[0] + ':';
            layoutRight = ':' + split[1];
        }

        this._titlebarLeft.set_decoration_layout(layoutLeft);
        this._titlebarRight.set_decoration_layout(layoutRight);
    },

    get active_room() {
        return this._room;
    },

    set active_room(room) {
        if (room == this._room)
            return;

        if (this._room) {
            this._room.disconnect(this._displayNameChangedId);
            this._room.disconnect(this._topicChangedId);
            this._room.disconnect(this._membersChangedId);
            this._room.disconnect(this._channelChangedId);
        }
        this._displayNameChangedId = 0;
        this._topicChangedId = 0;
        this._membersChangedId = 0;
        this._channelChangedId = 0;

        this._room = room;

        this._updateTitlebar();

        this.notify('active-room');
        this.notify('active-room-id');
        this.emit('active-room-state-changed');

        if (!this._room)
            return; // finished

        this._displayNameChangedId =
            this._room.connect('notify::display-name',
                               Lang.bind(this, this._updateTitlebar));
        this._topicChangedId =
            this._room.connect('notify::topic',
                               Lang.bind(this, this._updateTitlebar));
        this._membersChangedId =
            this._room.connect('members-changed',
                               Lang.bind(this, this._updateUserListLabel));
        this._channelChangedId =
            this._room.connect('notify::channel', () => {
                this._updateUserListLabel();
                this.emit('active-room-state-changed');
            });
    },

    get active_room_id() {
        return this._room ? this._room.id : '';
    },

    _addApplicationStyle: function() {
        let provider = new Gtk.CssProvider();
        let uri = 'resource:///org/gnome/Polari/css/application.css';
        let file = Gio.File.new_for_uri(uri);
        try {
            provider.load_from_file(Gio.File.new_for_uri(uri));
        } catch(e) {
            logError(e, "Failed to add application style");
        }
        Gtk.StyleContext.add_provider_for_screen(
            this.get_screen(),
            provider,
            Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION
        );
    },

    _onShowJoinDialog: function() {
        let dialog = new JoinDialog.JoinDialog({ transient_for: this });
        dialog.show();
    },

    _onLeaveCurrentRoom: function() {
        if (!this._room)
            return;
        let action = this.application.lookup_action('leave-room');
        action.activate(GLib.Variant.new('(ss)', [this._room.id, '']));
    },

    _leaveRoomCreateHook: function(action) {
        this.connect('notify::active-room', () => {
            action.enabled = this._room != null;
        });
        action.enabled = this._room != null;
    },

    _onToggleAction: function(action) {
        let state = action.get_state();
        action.change_state(GLib.Variant.new('b', !state.get_boolean()));
    },


    _updateUserListAction: function(action) {
        action.enabled = this._room &&
                         this._room.type == Tp.HandleType.ROOM &&
                         this._room.channel;
    },

    _userListCreateHook: function(action) {
        this.connect('active-room-state-changed', () => {
            this._updateUserListAction(action);
        });
        action.connect('notify::enabled', () => {
            if (!action.enabled)
                action.change_state(GLib.Variant.new('b', false));
        });
        this._updateUserListAction(action);
    },

    _roomNavCreateHook: function(action) {
        action.enabled = !this._singleRoom;
    },

    _updateUserListLabel: function() {
        let numMembers = 0;

        if (this._room &&
            this._room.channel &&
            this._room.channel.has_interface(Tp.IFACE_CHANNEL_INTERFACE_GROUP))
            numMembers = this._room.channel.group_dup_members_contacts().length;

        let accessibleName = ngettext("%d user",
                                      "%d users", numMembers).format(numMembers);
        this._showUserListButton.get_accessible().set_name(accessibleName);
        this._showUserListButton.label = '%d'.format(numMembers);
    },

    _updateTitlebar: function() {
        let subtitle = '';
        if (this._room && this._room.topic) {
            let urls = Utils.findUrls(this._room.topic);
            let pos = 0;
            for (let i = 0; i < urls.length; i++) {
                let url = urls[i];
                let text = this._room.topic.substr(pos, url.pos - pos);
                let urlText = GLib.markup_escape_text(url.url, -1);
                subtitle += GLib.markup_escape_text(text, -1) +
                            '<a href="%s">%s</a>'.format(urlText, urlText);
                pos = url.pos + url.url.length;
            }
            subtitle += GLib.markup_escape_text(this._room.topic.substr(pos), -1);
        }

        if (this._subtitle != subtitle) {
            this._subtitle = subtitle;
            this.notify('subtitle');
            this.notify('subtitle-visible');
        }

        this.title = this._room ? this._room.display_name : null;
    }
});
