import { useEffect, useState } from 'react';
import { Box, Flex } from '@chakra-ui/react';
import type { DroneState, FlashState } from '../types';
import ActivityLog from './ActivityLog';
import BatteryPanel from './BatteryPanel';
import CalibrationPanel from './CalibrationPanel';
import ConsolePanel from './ConsolePanel';
import DiagnosticsPanel from './DiagnosticsPanel';
import DroneFilesPanel from './DroneFilesPanel';
import DronePanel from './DronePanel';
import FastbootPanel from './FastbootPanel';
import FlashPanel from './FlashPanel';
import HmsPanel from './HmsPanel';
import ImageExplorerPanel from './ImageExplorerPanel';
import ImuCalibrationPanel from './ImuCalibrationPanel';
import MotorTestPanel from './MotorTestPanel';
import ParameterPanel from './ParameterPanel';
import RemoteControllerPanel from './RemoteControllerPanel';
import RepairPanel from './RepairPanel';
import ServicePanel from './ServicePanel';
import Sidebar, { type Page } from './Sidebar';
import StatusBar from './StatusBar';
import TelemetryPanel from './TelemetryPanel';
import TitleBar from './TitleBar';
import { useActivityLog } from './useActivityLog';
import { useDiagnostics } from './useDiagnostics';

const INITIAL_STATE: DroneState = {
  status: 'searching',
  scanning: false,
  modules: [],
};

const INITIAL_FLASH: FlashState = {
  phase: 'idle',
  files: [],
  totalSize: 0,
  message: '',
};

const ACTIVE_FLASH: FlashState['phase'][] = [
  'entering',
  'preparing',
  'transferring',
  'finishing',
  'monitoring',
];

/** Below this window width the activity log starts out hidden. */
const LOG_OPEN_MIN_WIDTH = 1120;

function App() {
  const [drone, setDrone] = useState<DroneState>(INITIAL_STATE);
  const [flash, setFlash] = useState<FlashState>(INITIAL_FLASH);
  const [page, setPage] = useState<Page>('device');
  const [logOpen, setLogOpen] = useState(() => window.innerWidth >= LOG_OPEN_MIN_WIDTH);
  const log = useActivityLog(drone);
  const diagnostics = useDiagnostics(log.add);

  useEffect(() => {
    const offState = window.drone.onState(setDrone);
    const offFlash = window.drone.onFlash(setFlash);
    void window.drone.getState().then(setDrone);
    void window.drone.getFlashState().then(setFlash);
    return () => {
      offState();
      offFlash();
    };
  }, []);

  return (
    <Flex direction="column" h="100vh">
      <TitleBar logOpen={logOpen} onToggleLog={() => setLogOpen((open) => !open)} />
      <Flex flex="1" minH="0">
        <Sidebar
          drone={drone}
          page={page}
          onNavigate={setPage}
          flashing={ACTIVE_FLASH.includes(flash.phase)}
          checking={diagnostics.running}
        />
        <Box as="main" flex="1" minW="0" overflowY="auto">
          <Box maxW="1040px" mx="auto" px="28px" pt="26px" pb="32px">
            {page === 'device' && <DronePanel drone={drone} />}
            {page === 'calibration' && <CalibrationPanel drone={drone} />}
            {page === 'imu' && <ImuCalibrationPanel drone={drone} />}
            {page === 'motors' && <MotorTestPanel drone={drone} onLog={log.add} />}
            {page === 'hms' && <HmsPanel drone={drone} />}
            {page === 'battery' && <BatteryPanel drone={drone} />}
            {page === 'telemetry' && <TelemetryPanel drone={drone} />}
            {page === 'diagnostics' && <DiagnosticsPanel drone={drone} check={diagnostics} />}
            {page === 'service' && <ServicePanel drone={drone} />}
            {page === 'repairs' && <RepairPanel drone={drone} onLog={log.add} />}
            {page === 'images' && <ImageExplorerPanel />}
            {page === 'dronefiles' && <DroneFilesPanel />}
            {page === 'console' && <ConsolePanel drone={drone} />}
            {page === 'fastboot' && <FastbootPanel drone={drone} onLog={log.add} />}
            {page === 'parameters' && <ParameterPanel drone={drone} onLog={log.add} />}
            {page === 'remote' && <RemoteControllerPanel />}
            {page === 'firmware' && <FlashPanel drone={drone} flash={flash} />}
          </Box>
        </Box>
        {logOpen && <ActivityLog entries={log.entries} onClear={log.clear} />}
      </Flex>
      <StatusBar drone={drone} />
    </Flex>
  );
}

export default App;
