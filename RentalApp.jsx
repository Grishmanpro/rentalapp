import React, { useState, useEffect, useRef } from "react";
import { BrowserProvider, Contract, parseEther, formatEther } from "ethers";
import ABI from "../abi/RentalContractABI.json";

const CONTRACT_ADDRESS = "0xEbD6F85cd7De5e515a426CEE9F92F6Be4c045BAd ";
const ETH_TO_RUB_RATE = 270000;
const GAS_BUFFER_ETH = 0.0003;
let ETHERSCAN_BASE = "";
const provider = new BrowserProvider(window.ethereum);
// Amplitude of random coordinate shift in degrees (~0.0005 deg ≈ 55 m)
const COORDINATE_NOISE = 0.001;
// Step when emulation leaves allowed zone. Change to control violation timing
const VIOLATION_STEP = 10;
// Step when emulation returns to allowed zone
const RETURN_STEP = VIOLATION_STEP + 5;

const formatCurrency = (value, isEth = false) => {
  if (isEth) {
    return parseFloat(value).toFixed(6) + " ETH";
  }
  const rubValue = parseFloat(value) * ETH_TO_RUB_RATE;
  return rubValue.toFixed(2).replace('.', ',') + " ₽";
};

export default function RentalApp() {
  const [wallet, setWallet] = useState({
    connected: false,
    address: "",
    network: "",
    balance: "0"
  });

  const [equipment, setEquipment] = useState({
    name: "",
    pricePerSecond: "0",
    minDeposit: "0",
    isReturnable: false,
    lessor: "",
    isAvailable: true,
    currentDeposit: "0"
  });

  const [rental, setRental] = useState({
    duration: "",
    status: "",
    startTime: null,
    timer: 0,
    isActive: false,
    fixedDuration: null,
    isPaused: false,
    pausedTime: 0,
    totalPausedDuration: 0,
    startTxHash: null,
    endTxHash: null,
    report: null,
    pausePending: false
  });

  const [forcedPauseReason, setForcedPauseReason] = useState(null); // null | "zone"

  const [chainTimer, setChainTimer] = useState(0);

  // Step counter for coordinate emulation
  const simulationStepRef = useRef(0);

  const [contractStatus, setContractStatus] = useState("");


  const [calculation, setCalculation] = useState({
    estimatedCostEth: null,
    estimatedCostRub: null,
    canAfford: true
  });

  const [coordinates, setCoordinates] = useState({ lat: 55.75, lng: 37.61 });

  const [geoZones, setGeoZones] = useState({
    allowed: {
      lat: 55.750000,
      lng: 37.610000,
      radius: 100 // в метрах
    },
    restricted: {
      lat: 0,
      lng: 0,
      radius: 100
    }
  });

  const [simulateViolation, setSimulateViolation] = useState(false);
  
  const generateRestrictedZone = (allowedZone) => {
    const offsetMeters = allowedZone.radius + 50; // немного дальше рабочей зоны
    const offsetDegrees = offsetMeters / 111000;

    return {
      lat: allowedZone.lat + offsetDegrees,
      lng: allowedZone.lng + offsetDegrees,
      radius: 200
    };
  };
  


  // Подключение кошелька и загрузка данных
  const connectWallet = async () => {
    if (!window.ethereum) {
      updateStatus("Установите MetaMask");
      return;
    }

    try {
      
      const accounts = await provider.send("eth_requestAccounts", []);
      const signer = await provider.getSigner();
      const network = await provider.getNetwork();
      switch (network.chainId) {
        case 1:
          ETHERSCAN_BASE = "https://etherscan.io/tx/";
          break;
        case 5:
          ETHERSCAN_BASE = "https://goerli.etherscan.io/tx/";
          break;
        case 11155111:
          ETHERSCAN_BASE = "https://sepolia.etherscan.io/tx/";
          break;
        default:
          ETHERSCAN_BASE = `https://${network.name}.etherscan.io/tx/`;
      }
      const balance = await provider.getBalance(accounts[0]);
      
      const contract = new Contract(CONTRACT_ADDRESS, ABI, signer);
      window.contract = contract;

      const currentStatus = await fetchAdjustedStatus();
      setContractStatus(currentStatus);

      if (currentStatus !== "Available") {
        try {
          const used = await contract.calculateUsedTime();
          setChainTimer(Number(used));
        } catch (e) {
          console.error("Ошибка получения времени контракта:", e);
        }
      }

      // Подписываемся на события паузы/возобновления
      contract.on("RentalPaused", async () => {
        setRental(prev => ({ ...prev, isPaused: true, pausePending: false }));
        const status = await fetchAdjustedStatus();
        setContractStatus(status);
      });
      contract.on("RentalResumed", async () => {
        setRental(prev => ({ ...prev, isPaused: false, pausePending: false }));
        const status = await fetchAdjustedStatus();
        setContractStatus(status);
      });

      const equipmentData = await Promise.all([
        contract.equipmentName(),
        contract.pricePerSecond(),
        contract.minDeposit(),
        contract.isReturnable(),
        contract.lessor()
      ]);

      const geoData = await Promise.all([
        contract.centerLat(),
        contract.centerLon(),
        contract.radius()
      ]);
      
      const allowedLat = Number(geoData[0]) / 1e6;
      const allowedLng = Number(geoData[1]) / 1e6;
      const allowedRadius = Number(geoData[2]);

      setGeoZones(prev => ({
        ...prev,
        allowed: {
          lat: allowedLat,
          lng: allowedLng,
          radius: allowedRadius
        },
        restricted: generateRestrictedZone({
          lat: allowedLat,
          lng: allowedLng,
          radius: allowedRadius
        })
      }));

// Устанавливаем начальные координаты точно в центр рабочей зоны
setCoordinates({ lat: allowedLat, lng: allowedLng });

      setWallet({
        connected: true,
        address: accounts[0],
        network: network.name,
        balance: formatEther(balance)
      });

      setEquipment({
        ...equipment,
        name: equipmentData[0],
        pricePerSecond: formatEther(equipmentData[1]),
        minDeposit: formatEther(equipmentData[2]),
        isReturnable: equipmentData[3],
        lessor: equipmentData[4]
      });

      updateStatus("Кошелёк подключен");

    } catch (error) {
      console.error("Ошибка подключения:", error);
      updateStatus("Ошибка подключения");
    }
  };


  const fetchAdjustedStatus = async () => {
    const data = await window.contract.activeRental();
    if (!data.isActive) return "Available";
    if (data.isPaused) return "Paused";
    const used = await window.contract.calculateUsedTime();
    const maxDur = Number(data.endTime) - Number(data.startTime);
    return used >= maxDur ? "Overdue" : "Active";
  };

  // Отсчёт времени и геоконтроль
  useEffect(() => {
    if (!rental.isActive || rental.isPaused || contractStatus !== "Active") return;

    const interval = setInterval(() => {
      // Увеличиваем таймер только когда контракт активен и аренда не на паузе
      setRental(prev =>
        prev.isPaused || contractStatus !== "Active"
          ? prev
          : { ...prev, timer: prev.timer + 1 }
      );

      // Эмуляция координат и проверка зоны
      setCoordinates(prev => {
        if (rental.isPaused || forcedPauseReason === "zone" || contractStatus !== "Active") {
          // keep the last position and skip random movement during any pause
          return prev;
        }

        let newLat = prev.lat;
        let newLng = prev.lng;

        if (simulateViolation) {
          simulationStepRef.current += 1;

          newLat = parseFloat(
            (prev.lat + (Math.random() - 0.5) * COORDINATE_NOISE).toFixed(6)
          );
          newLng = parseFloat(
            (prev.lng + (Math.random() - 0.5) * COORDINATE_NOISE).toFixed(6)
          );

          if (simulationStepRef.current === VIOLATION_STEP) {
            // выходим из рабочей зоны
            newLat = geoZones.restricted.lat;
            newLng = geoZones.restricted.lng;
          } else if (simulationStepRef.current === RETURN_STEP) {
            // возвращаемся в рабочую зону
            newLat = geoZones.allowed.lat;
            newLng = geoZones.allowed.lng;
            simulationStepRef.current = 0;
          }
        } else {
          // Держим координаты в центре разрешённой зоны
          newLat = geoZones.allowed.lat;
          newLng = geoZones.allowed.lng;
        }

        const latE6 = Math.floor(newLat * 1e6);
        const lonE6 = Math.floor(newLng * 1e6);
        const centerLatE6 = Math.floor(geoZones.allowed.lat * 1e6);
        const centerLonE6 = Math.floor(geoZones.allowed.lng * 1e6);

        const metersLat = Math.abs(latE6 - centerLatE6) * 111000 / 1e6;
        const metersLon = Math.abs(lonE6 - centerLonE6) * 111000 / 1e6;
        const dist2 = metersLat ** 2 + metersLon ** 2;

        if (
          dist2 > geoZones.allowed.radius ** 2 &&
          contractStatus === "Active" &&
          !forcedPauseReason
        ) {
          setRental(prevRental => ({ ...prevRental, pausePending: true }));
          window.contract
            .pauseRental()
            .catch(e => {
              console.error("Ошибка при авто-паузе:", e);
              setRental(prevRental => ({ ...prevRental, pausePending: false }));
            });
          setForcedPauseReason("zone");
          updateStatus(
            "⚠️ Вы покинули рабочую зону. Ожидание подтверждения паузы..."
          );
        } else if (
          dist2 <= geoZones.allowed.radius ** 2 &&
          forcedPauseReason === "zone" &&
          rental.isPaused &&
          contractStatus === "Paused"
        ) {
          setRental(prevRental => ({ ...prevRental, pausePending: true }));
          window.contract
            .resumeRental()
            .catch(e => {
              console.error("Ошибка при авто-возобновлении:", e);
              setRental(prevRental => ({ ...prevRental, pausePending: false }));
            });
          setForcedPauseReason(null);
          simulationStepRef.current = 0;
          updateStatus("✅ Техника вернулась в рабочую зону. Возобновляем работу...");
        }

        return { lat: newLat, lng: newLng };
      });

      // Автозавершение аренды
      setRental(prev => {
        if (prev.fixedDuration && prev.timer >= prev.fixedDuration) {
          return { ...prev, isActive: false };
        }
        return prev;
      });
    }, 1000);

    return () => clearInterval(interval);
  }, [rental.isActive, rental.isPaused, contractStatus, simulateViolation]);

  // При выключенной симуляции держим координаты в центре рабочей зоны
  useEffect(() => {
    if (!simulateViolation && contractStatus === "Active") {
      setCoordinates({ lat: geoZones.allowed.lat, lng: geoZones.allowed.lng });
    }
  }, [simulateViolation, geoZones.allowed.lat, geoZones.allowed.lng, contractStatus]);

  // Периодически обновляем статус контракта
  useEffect(() => {
    if (!wallet.connected) return;
      const id = setInterval(() => {
        fetchAdjustedStatus().then(setContractStatus).catch(() => {});
      }, 3000);
    return () => clearInterval(id);
  }, [wallet.connected]);

  // Получаем фактическое время из контракта
  useEffect(() => {
    if (!wallet.connected || rental.startTime === null) return;
    const id = setInterval(() => {
      window.contract
        .calculateUsedTime()
        .then(t => setChainTimer(Number(t)))
        .catch(e => console.error("Ошибка получения времени контракта:", e));
    }, 1000);
    return () => clearInterval(id);
  }, [wallet.connected, rental.startTime]);


  // Обработчик паузы с интеграцией контракта
  const handlePause = async () => {
    try {
      setRental(prev => ({ ...prev, pausePending: true }));
      if (rental.isPaused) {
        updateStatus("⏳ Подтверждение возобновления...");
        const tx = await window.contract.resumeRental({ gasLimit: 250000 });
        await tx.wait();
        simulationStepRef.current = 0;
      } else {
        updateStatus("⏳ Подтверждение паузы...");
        const tx = await window.contract.pauseRental({ gasLimit: 250000 });
        await tx.wait();
      }

      const status = await fetchAdjustedStatus();
      setContractStatus(status);

      const rentalData = await window.contract.activeRental();
      setRental(prev => ({
        ...prev,
        isPaused: rentalData.isPaused,
        totalPausedDuration: Number(rentalData.pausedDuration),
        pausePending: false
      }));

      try {
        const used = await window.contract.calculateUsedTime();
        setChainTimer(Number(used));
      } catch (e) {
        console.error("Ошибка получения времени контракта:", e);
      }

    } catch (error) {
      console.error("Ошибка паузы:", error);
      setRental(prev => ({ ...prev, pausePending: false }));
      updateStatus(`❌ ${error.reason?.split(":")[1] || "Ошибка транзакции"}`);
    }
  };

  const updateStatus = (message) => {
    setRental(prev => ({ ...prev, status: message }));
  };

  // Начало аренды
  const startRental = async () => {
    if (!rental.duration || parseInt(rental.duration) <= 0) {
      updateStatus("Введите корректную длительность");
      return;
    }
  
    try {
      const latE6 = Math.floor(coordinates.lat * 1e6);
      const lonE6 = Math.floor(coordinates.lng * 1e6);
  
      const centerLatE6 = Math.floor(geoZones.allowed.lat * 1e6);
      const centerLonE6 = Math.floor(geoZones.allowed.lng * 1e6);
  
      const metersLat = Math.abs(latE6 - centerLatE6) * 111000 / 1e6;
      const metersLon = Math.abs(lonE6 - centerLonE6) * 111000 / 1e6;
      const distance2 = metersLat ** 2 + metersLon ** 2;
  
      if (distance2 > geoZones.allowed.radius ** 2) {
        updateStatus("⛔ Вы находитесь вне рабочей зоны. Переместитесь в зону перед арендой.");
        return;
      }
  
      updateStatus("⏳ Подписание транзакции...");
      const totalCost = parseFloat(equipment.pricePerSecond) * parseInt(rental.duration);
  
      const tx = await window.contract.rent(
        parseInt(rental.duration),
        latE6,
        lonE6,
        { value: parseEther(totalCost.toString()) }
      );

      await tx.wait();
      simulationStepRef.current = 0;
      setChainTimer(0);

      setRental(prev => ({
        ...prev,
        startTime: Math.floor(Date.now() / 1000),
        fixedDuration: parseInt(rental.duration),
        isActive: true,
        isPaused: false,
        totalPausedDuration: 0,
        status: "✅ Аренда началась",
        startTxHash: tx.hash,
        endTxHash: null,
        report: null
      }));
      setContractStatus("Active");
  
    } catch (error) {
      console.error("Ошибка аренды:", error);
      updateStatus(`❌ Ошибка при аренде: ${error.reason || error.message}`);
    }
  };
  
  

  // Расчет стоимости
  const calculateEstimate = () => {
    if (!rental.duration || parseInt(rental.duration) <= 0) {
      updateStatus("Введите длительность для расчёта");
      return;
    }

    const pricePerSec = parseFloat(equipment.pricePerSecond || "0");
    const seconds = parseInt(rental.duration);
    const ethValue = pricePerSec * seconds;

    setCalculation({
      estimatedCostEth: ethValue.toFixed(6),
      estimatedCostRub: formatCurrency(ethValue),
      canAfford: parseFloat(wallet.balance) >= (ethValue + GAS_BUFFER_ETH)
    });

    updateStatus("✅ Стоимость рассчитана");
  };


 
   // Обновлённый метод возврата оборудования
   const returnEquipment = async () => {
    try {
      updateStatus("⏳ Завершение аренды...");
      const tx = await window.contract.returnEquipment({ gasLimit: 300000 });
      const receipt = await tx.wait();
      
      // Получаем актуальные данные из контракта
      let event = receipt.events?.find(e => e.event === "RentalEnded");

      // Fallback для сетей без receipt.events
      if (!event) {
        for (const log of receipt.logs) {
          try {
            const parsed = window.contract.interface.parseLog(log);
            if (parsed.name === "RentalEnded") {
              event = { args: parsed.args };
              break;
            }
          } catch (e) {
            // ignore parse errors
          }
        }
      }

      if (!event || !event.args) {
        console.error("RentalEnded event not found", receipt);
        updateStatus("❌ Событие RentalEnded не найдено");
        return;
      }

      const usedSeconds = parseInt(event.args.usedSeconds.toString());
      const amountPaid = formatEther(event.args.amountPaid.toString());
      const refundAmount = formatEther(event.args.refundAmount.toString());
      const depositAmount = (
        parseFloat(amountPaid) + parseFloat(refundAmount)
      ).toFixed(6);

      setRental(prev => ({
        ...prev,
        isActive: false,
        startTime: null,
        timer: usedSeconds,

        status: `🔁 Аренда завершена. Возвращено: ${refundAmount} ETH`,
        endTxHash: tx.hash,
        report: {
          usedSeconds,
          amountPaid,
          refundAmount,
          deposit: depositAmount
        }
      }));
      setChainTimer(usedSeconds);
      setContractStatus("Available");

      // Обновляем баланс кошелька
      const newBalance = await provider.getBalance(wallet.address);
      setWallet(prev => ({ ...prev, balance: formatEther(newBalance) }));

    } catch (error) {
      console.error("Ошибка возврата:", error);
      updateStatus(`❌ Ошибка: ${error.reason?.split(":")[1] || error.message}`);
    }
  };

  // Проверка статуса
  const checkStatus = async () => {
      try {
        const status = await fetchAdjustedStatus();
        setContractStatus(status);
        try {
          const used = await window.contract.calculateUsedTime();
          setChainTimer(Number(used));
        } catch (e) {
          console.error("Ошибка получения времени контракта:", e);
        }
        updateStatus(`📋 Статус: ${status}`);
    } catch (error) {
      console.error("Ошибка проверки статуса:", error);
      updateStatus("❌ Ошибка проверки статуса");
    }
  };

  // Расчет текущей стоимости
  const currentCostEth = parseFloat(equipment.pricePerSecond) * Math.min(
    rental.timer, 
    rental.fixedDuration || 0
  );
  
  const progressPercent = rental.fixedDuration 
    ? Math.min((rental.timer / rental.fixedDuration) * 100, 100) 
    : 0;
    
////////////////////////////////////////
  return (
    <div className="min-h-screen flex bg-slate-50 text-gray-900 font-sans">
      {/* Основное содержимое */}
      <main className="flex-1 p-10">
        {/* Шапка */}
        <div className="flex justify-between items-center mb-6">
          <h1 className="text-2xl font-bold">Аренда спецтехники</h1>
          {contractStatus && (
            <span className="text-sm text-gray-600">Статус: {contractStatus}</span>
          )}
          
          {!wallet.connected ? (
            <button
              onClick={connectWallet}
              className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-1.5 rounded-md text-sm"
            >
              Подключить MetaMask
            </button>
          ) : (
            <div className="flex items-center bg-gray-100 border border-gray-200 px-4 py-2 rounded-md text-xs text-gray-600 font-mono space-x-2">
              <span>🟢 {wallet.address.slice(0, 6)}...{wallet.address.slice(-4)}</span>
              <span className="text-gray-500">({wallet.network})</span>
              <button
                onClick={() => {
                  setWallet({
                    connected: false,
                    address: "",
                    network: "",
                    balance: "0"
                  });
                  updateStatus("Отключено");
                }}
                className="text-red-500 hover:underline text-[11px]"
              >
                Отключить
              </button>
            </div>
          )}
        </div>

        {/* Информация об оборудовании */}
        <div className="bg-white rounded-xl shadow border border-gray-200 p-6 max-w-2xl mb-6">
          <h2 className="text-xl font-semibold mb-2 text-gray-800">Информация о технике</h2>
          <ul className="text-sm text-gray-700 space-y-1">
            <li><strong>Название:</strong> {equipment.name || "—"}</li>
            <li>
              <strong>Цена за секунду:</strong> {formatCurrency(equipment.pricePerSecond, true)} (
              {formatCurrency(equipment.pricePerSecond)})
            </li>
            <li>
              <strong>Минимальный депозит:</strong> {formatCurrency(equipment.minDeposit, true)} (
              {formatCurrency(equipment.minDeposit)})
            </li>
            <li><strong>Досрочный возврат:</strong> {equipment.isReturnable ? "Да" : "Нет"}</li>
            <li>
              <strong>Арендодатель:</strong>{" "}
              <span className="font-mono">
                {equipment.lessor?.slice(0, 6)}...{equipment.lessor?.slice(-4)}
              </span>
              {wallet.address.toLowerCase() === equipment.lessor.toLowerCase() && (
                <span className="ml-2 text-xs text-green-500 font-medium">(Вы)</span>
              )}
                <li>
                  <strong>Рабочая геозона:</strong><br />
                  Центр: {geoZones.allowed.lat}, {geoZones.allowed.lng}<br />
                  Радиус: {geoZones.allowed.radius} м
                </li>
                <li>
                  <strong>Запретная зона:</strong><br />
                  Центр: {geoZones.restricted.lat}, {geoZones.restricted.lng}<br />
                  Радиус: {geoZones.restricted.radius} м
                </li>

              <strong>Статус контракта:</strong>{" "}
              <span className="font-medium">{contractStatus || "—"}</span>
            </li>
          </ul>
        </div>

        {/* Форма аренды */}
        <div className="bg-white rounded-xl shadow border border-gray-200 p-6 max-w-2xl space-y-6">
          <div className="grid gap-4">
            <label className="text-sm">Длительность аренды (в секундах)</label>
          <input
            type="number"
            value={rental.duration}
            onChange={(e) => setRental(prev => ({...prev, duration: e.target.value}))}
            placeholder="например, 3600"
            className="w-full border border-gray-300 px-4 py-2 rounded-md shadow-sm text-sm"
          />
          </div>

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={simulateViolation}
              onChange={(e) => setSimulateViolation(e.target.checked)}
              className="form-checkbox h-4 w-4 text-blue-600"
            />
            <span>Эмулировать нарушение геозоны</span>
          </label>

          <div className="text-sm text-gray-600">
            💰 Баланс: {formatCurrency(wallet.balance, true)} ({formatCurrency(wallet.balance)})
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
            <button
              onClick={startRental}
              disabled={!equipment.isAvailable || !calculation.canAfford}
              className={`py-2 rounded-md shadow-sm text-white ${
                equipment.isAvailable
                ? "bg-blue-600 hover:bg-blue-700"
                : "bg-gray-400 cursor-not-allowed"
              }`}
            >
              Арендовать
            </button>

            <button
              onClick={checkStatus}
              className="bg-white border border-gray-200 hover:bg-gray-100 text-gray-700 py-2 rounded-md shadow-sm"
            >
              Статус
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-sm">
            <button
              onClick={calculateEstimate}
              className="bg-green-500 hover:bg-yellow-600 text-white py-2 rounded-md shadow-sm"
            >
              Рассчитать
            </button>
          </div>

          {calculation.estimatedCostEth && (
            <div className="text-sm text-gray-800 pt-2 border-t">
              💰 Ориентировочная стоимость: {formatCurrency(calculation.estimatedCostEth)} (
              {calculation.estimatedCostEth} ETH)
              <div className="text-sm text-gray-600 pt-2 flex items-center gap-2">
                Прогноз: {calculation.canAfford ? (
                  <span className="text-green-600 font-medium">✔ Достаточно средств</span>
                ) : (
                  <span className="text-red-600 font-medium">❌ Недостаточно средств</span>
                )}
                <span className="text-xs text-gray-400">(включая {GAS_BUFFER_ETH} ETH на gas)</span>
              </div>
            </div>
          )}

          {rental.status && (
            <div className="text-sm text-blue-700 pt-4 border-t">{rental.status}</div>
          )}
        </div>

        {/* Отслеживание аренды */}
        {rental.startTime !== null && (
          <div className="bg-white rounded-xl shadow border border-gray-200 p-6 max-w-2xl mt-6 space-y-4">
            <h2 className="text-lg font-semibold text-gray-800">⏱ Отслеживание аренды</h2>
            <p className="text-sm text-gray-600">Статус: {contractStatus}</p>
            {rental.pausePending && (
              <div className="bg-yellow-100 border border-yellow-300 text-yellow-800 p-2 rounded text-sm">
                ⏳ Транзакция выполняется. Счётчик продолжает идти
              </div>
            )}
            {forcedPauseReason === "zone" && (
              <div className="bg-red-100 border border-red-300 text-red-800 p-2 rounded text-sm">
                Техника находится вне геозоны
              </div>
            )}
            <div className="space-y-1">
              <p className="text-gray-700 font-medium">
                Время аренды: {Math.min(rental.timer, rental.fixedDuration)} сек / {rental.fixedDuration} сек
              </p>
              <p className="text-gray-600">
                ⏱ По контракту: {chainTimer} сек
              </p>
              <p className="text-gray-600">
                📍 Координаты: {coordinates.lat}, {coordinates.lng}
                </p>
              <p className="text-gray-600">
                💸 Стоимость: {formatCurrency(currentCostEth)} (
                {currentCostEth.toFixed(6)} ETH)
              </p>
              <div className="w-full h-2 bg-gray-200 rounded overflow-hidden">
                <div
                  className="bg-blue-600 h-full transition-all"
                  style={{ width: `${progressPercent}%` }}
                />
              </div>
            </div>
            <div className="pt-2 flex gap-2 flex-wrap">
            <button
                onClick={handlePause}
                disabled={forcedPauseReason === "zone" || rental.pausePending}
                className={`px-4 py-2 rounded-md text-sm shadow text-white ${
                  forcedPauseReason === "zone" || rental.pausePending
                    ? "bg-gray-400 cursor-not-allowed"
                    : "bg-yellow-500 hover:bg-yellow-600"
                }`}
                >
                {rental.pausePending
                  ? "..."
                  : rental.isPaused
                  ? "▶ Продолжить"
                  : "⏸ Пауза"}
                </button>



                  {forcedPauseReason === "zone" && (
                    <button
                      onClick={() => {
                        setCoordinates({
                          lat: geoZones.allowed.lat,
                          lng: geoZones.allowed.lng
                        });
                        setForcedPauseReason(null);
                        updateStatus("🔄 Координаты возвращены в рабочую зону.");
                      }}
                      className="bg-orange-500 hover:bg-orange-600 text-white px-4 py-2 rounded-md text-sm shadow"
                    >
                      ⬅ Вернуться в зону
                    </button>
                  )}


                    <button
                      onClick={returnEquipment}
                      className="bg-red-500 hover:bg-red-600 text-white px-4 py-2 rounded-md text-sm shadow"
                    >
                      ⛔ Завершить
                    </button>

            </div>
            <div className="text-sm text-gray-700 pt-4 border-t">
              <p><strong>Чек аренды:</strong></p>
              <p>⏱ Время: {Math.min(rental.timer, rental.fixedDuration)} сек</p>
              <p>⏱ По контракту: {chainTimer} сек</p>
              <p>💰 Сумма: {formatCurrency(currentCostEth)}</p>
              {rental.endTxHash && rental.report && (
                <div className="pt-2 space-y-1">
                  <p><strong>Отчёт о сделке:</strong></p>
                  <p>
                    Начало:{" "}
                    <a
                      href={`${ETHERSCAN_BASE}${rental.startTxHash}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-blue-600 underline"
                    >
                      посмотреть
                    </a>
                  </p>
                  <p>
                    Завершение:{" "}
                    <a
                      href={`${ETHERSCAN_BASE}${rental.endTxHash}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-blue-600 underline"
                    >
                      посмотреть
                    </a>
                  </p>
                  <p>Депозит: {formatCurrency(rental.report.deposit, true)} ({formatCurrency(rental.report.deposit)})</p>
                  <p>Удержано: {formatCurrency(rental.report.amountPaid, true)} ({formatCurrency(rental.report.amountPaid)})</p>
                  <p>Возврат: {formatCurrency(rental.report.refundAmount, true)} ({formatCurrency(rental.report.refundAmount)})</p>
                </div>
              )}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
