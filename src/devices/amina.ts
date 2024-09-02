const {deviceAddCustomCluster, onOff, binary, numeric, enumLookup, electricityMeter} = require('zigbee-herdsman-converters/lib/modernExtend');
const fz = require('zigbee-herdsman-converters/converters/fromZigbee');
const tz = require('zigbee-herdsman-converters/converters/toZigbee');
const exposes = require('zigbee-herdsman-converters/lib/exposes');
const reporting = require('zigbee-herdsman-converters/lib/reporting');
const utils = require('zigbee-herdsman-converters/lib/utils');
const ota = require('zigbee-herdsman-converters/lib/ota');
const constants = require('zigbee-herdsman-converters/lib/constants');
const e = exposes.presets;
const ea = exposes.access;

const aminaManufacturer = {manufacturerCode: 0x143B};

const Amina_S_Control = {
    cluster: 0xFEE7,
    alarms: 0x02,
    ev_status: 0x03,
    connect_status: 0x04,
    single_phase: 0x05,
    offline_current: 0x06,
    offline_single_phase: 0x07,
    time_to_offline: 0x08,
    enable_offline: 0x09,
    total_active_energy: 0x10,
    last_session_energy: 0x11,
}

const Amina_S_Alarms = ['Welded relay(s)', 'Wrong voltage balance', 'RDC-DD DC Leakage', 'RDC-DD AC Leakage', 
                        'Temperature error', 'Overvoltage alarm', 'Overcurrent alarm', 'Car communication error',
                        'Charger processing error', 'Critical overcurrent alarm'];

const DataType = {
    uint32: 35,
    uint16: 33,
    uint8: 0x20,
    enum8: 0x30,
    bitmap16: 25,
}

const fzLocal = {
    charge_limit: {
        cluster: "genLevelCtrl",
        type: ["attributeReport", "readResponse"],
        convert: (model, msg, publish, options, meta) => {
            const result = {};
            if (msg.data.hasOwnProperty("currentLevel")) {
                result.charge_limit = msg.data["currentLevel"];
            }
            
            return result;
        },
    },

    amina_s: {
        cluster: 'aminaControlCluster',
        type: ["attributeReport", "readResponse"],
        convert: (model, msg, publish, options, meta) => {
            const result = {};
            if (msg.data.hasOwnProperty(Amina_S_Control.charge_limit_max)) {
                result.charge_limit_max = msg.data[Amina_S_Control.charge_limit_max];
            }
            
            if (msg.data.hasOwnProperty('alarms')) {
                result.alarms = [];
                result.alarm_active = false;

                for (let i = 0; i < Amina_S_Alarms.length; i++){
                    if ((msg.data['alarms'] >> i) & 0x01) {
                        result.alarms.push(Amina_S_Alarms[i]);
                        result.alarm_active = true;
                    }
                }
            }
 
            return result;
        },
    },
};

const tzLocal = {
    amina_s: {
        key: ['charge_limit'],
        convertSet: async (entity, key, value, meta) => {
            const endpoint = entity.getDevice().getEndpoint(10);
            switch(key) {
                case 'charge_limit':
                    const payload = {level: value, transtime: 0};
                    await endpoint.command('genLevelCtrl', 'moveToLevel', payload, utils.getOptions(meta.mapped, entity));
                    break;
            }
        },
        
        convertGet: async (entity, key, meta) => {
            const endpoint = entity.getDevice().getEndpoint(10);
            switch(key) {
              case 'charge_limit':
                await endpoint.read('genLevelCtrl', ['currentLevel'], aminaManufacturer);
                break;
            }
        },
    },
};

const definition = {
    zigbeeModel: ['amina S'],
    model: 'amina S',
    vendor: 'Amina Distribution AS',
    description: 'Amina S EV Charger',
    ota: ota.zigbeeOTA,
    fromZigbee: [fzLocal.charge_limit, fz.electrical_measurement, fzLocal.amina_s, fz.frequency],
    toZigbee: [tzLocal.amina_s, tz.electrical_measurement_power, fz.frequency, tz.acvoltage, tz.accurrent],
    exposes: [e.numeric('charge_limit', ea.ALL).withUnit('A')
                .withValueMin(6).withValueMax(32).withValueStep(1) // TODO: read min and max value from level control cluster
                .withDescription('Maximum allowed amperage draw'),
              e.numeric('alarms', ea.STATE).withDescription('Alarms reported by EV Charger'),
              e.binary('alarm_active', ea.STATE, 'true', 'false').withDescription('An active alarm is present'),

              e.ac_frequency().withAccess(ea.STATE_GET), // TODO: Needs divisor of 10 read from device
        ],

    extend: [
        electricityMeter({
            'threePhase': true
        }),
        deviceAddCustomCluster(
            'aminaControlCluster',
            {
                ID: Amina_S_Control.cluster,
                manufacturerCode: aminaManufacturer,
                attributes: {
                    alarms: {ID: Amina_S_Control.alarms, type: DataType.bitmap16},
                    evStatus: {ID: Amina_S_Control.ev_status, type: DataType.bitmap16},
                    connectStatus: {ID: Amina_S_Control.connect_status, type: DataType.bitmap16}, // Not implemented?
                    singlePhase: {ID: Amina_S_Control.single_phase, type: DataType.uint8},
                    offlineCurrent: {ID: Amina_S_Control.offline_current, type: DataType.uint8},
                    offlineSinglePhase: {ID: Amina_S_Control.offline_single_phase, type: DataType.uint8},
                    timeToOffline: {ID: Amina_S_Control.time_to_offline, type: DataType.uint16},
                    enableOffline: {ID: Amina_S_Control.enable_offline, type: DataType.uint8},
                    totalActiveEnergy: {ID: Amina_S_Control.total_active_energy, type: DataType.uint32},
                    lastSessionEnergy: {ID: Amina_S_Control.last_session_energy, type: DataType.uint32},
                },
                commands: {},
                commandsResponse: {},
            }
        ),

        onOff({
            'powerOnBehavior': false,
        }),

        enumLookup({
            name: 'ev_status',
            cluster: 'aminaControlCluster',
            attribute: 'evStatus',
            lookup: {'Not Connected': 0, 'EV Connected': 1, 'Ready to Charge': 3, 'Charging': 7, 'Paused': 11},
            description: 'Current charging status',
            access: 'STATE_GET',
        }),

        enumLookup({
            name: 'connect_status',
            cluster: 'aminaControlCluster',
            attribute: 'connectStatus',
            lookup: {'Wi-Fi connection': 0, 'Cellular connection': 1, 'OCPP connection': 2, 'Zigbee connection': 4, 'Bluetooth connection': 5, 'Authorization waiting': 14, 'Authorization approved': 15},
            description: 'Current charging status',
            access: 'STATE_GET',
        }),

        numeric({
            name: 'single_phase',
            cluster: 'aminaControlCluster',
            attribute: 'singlePhase',
            description: 'Enable single phase charging. A restart of charging is required for the change to take effect.',
            access: 'ALL',
        }),

        numeric({
            name: 'offline_current',
            cluster: 'aminaControlCluster',
            attribute: 'offlineCurrent',
            description: 'Amount of current to draw when device is offline.',
            access: 'ALL',
        }),

        numeric({
            name: 'offline_single_phase',
            cluster: 'aminaControlCluster',
            attribute: 'offlineSinglePhase',
            description: 'Enable single phase charging when device is offline',
            access: 'ALL',
        }),

        numeric({
            name: 'time_to_offline',
            cluster: 'aminaControlCluster',
            attribute: 'timeToOffline',
            description: 'Time until charger will behave as offline after connection has been lost.',
            access: 'ALL',
        }),

        numeric({
            name: 'enable_offline',
            cluster: 'aminaControlCluster',
            attribute: 'enableOffline',
            description: 'Enable offline mode when connection to the network is lost.',
            access: 'ALL',
        }),

        numeric({
            name: 'total_active_energy',
            cluster: 'aminaControlCluster',
            attribute: 'totalActiveEnergy',
            description: 'Sum of consumed energy',
            unit: 'Wh',
            access: 'STATE_GET',
        }),

        numeric({
            name: 'last_session_energy',
            cluster: 'aminaControlCluster',
            attribute: 'lastSessionEnergy',
            description: 'Sum of consumed energy last session',
            unit: 'Wh',
            access: 'STATE_GET',
        }),
    ],

    endpoint: (device) => {
        return {'default': 10};
    },

    configure: async (device, coordinatorEndpoint, logger) => {
        const endpoint = device.getEndpoint(10);

        await endpoint.read(Amina_S_Control.cluster, [// Amina_S_Control.max_current_level, // Not implemented?
                                                    Amina_S_Control.alarms,
                                                    Amina_S_Control.ev_status,
                                                    Amina_S_Control.connect_status,
                                                    Amina_S_Control.single_phase,
                                                    Amina_S_Control.offline_current,
                                                    Amina_S_Control.offline_single_phase,
                                                    Amina_S_Control.time_to_offline,
                                                    Amina_S_Control.enable_offline,
                                                    Amina_S_Control.total_active_energy,
                                                    Amina_S_Control.last_session_energy
                                                    ]);
    },

};
