import React, { useState, useEffect } from "react";
import { BrowserProvider, Contract, parseEther, formatEther } from "ethers";
import ABI from "../abi/RentalContractABI.json";

const CONTRACT_ADDRESS = "0x43182Ae66569CE85C9aB8Aa45b94A66743EcCa88";
const ETH_TO_RUB_RATE = 270000;
const GAS_BUFFER_ETH = 0.0003;
const provider = new BrowserProvider(window.ethereum);

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
    totalPausedDuration: 0
  });

  const [forcedPauseReason, setForcedPauseReason] = useState(null); // null | "zone"

  const [shouldResume, setShouldResume] = useState(false);


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
  
  const generateRestrictedZone = (allowedZone, offsetMeters = 100) => {
    const offsetDegrees = offsetMeters / 111000; // ≈ 150м в градусах
  
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
      const balance = await provider.getBalance(accounts[0]);
      
      const contract = new Contract(CONTRACT_ADDRESS, ABI, signer);
      window.contract = contract;

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

  // Таймер с учётом пауз
  useEffect(() => {
    const restricted = generateRestrictedZone(geoZones.allowed);
    setGeoZones(prev => ({ ...prev, restricted }));

    let interval;
  
    const updateTimer = async () => {
      try {
        // Получаем актуальные данные из контракта
        const rentalData = await window.contract.activeRental();
        const currentTime = Math.floor(Date.now() / 1000);
    
        // Рассчитываем прошедшее время с учётом пауз
        const totalPaused = Number(rentalData.pausedDuration);
        const effectiveStartTime = Number(rentalData.startTime) + totalPaused;
        const elapsed = currentTime - effectiveStartTime;
        const correctedElapsed = Math.min(elapsed, rental.fixedDuration);
    
        setRental(prev => ({
          ...prev,
          timer: correctedElapsed,
          isPaused: rentalData.isPaused,
          totalPausedDuration: totalPaused
        }));
    
        // Эмуляция координат
        setCoordinates(prev => {
          const newLat = prev.lat + (Math.random() - 0.5) * 0.0001;
          const newLng = prev.lng + (Math.random() - 0.5) * 0.0001;
          return {
            lat: parseFloat(newLat.toFixed(6)),
            lng: parseFloat(newLng.toFixed(6))
          };
        });
    
        // Проверка запретной зоны
        const latE6 = Math.floor(coordinates.lat * 1e6);
        const lonE6 = Math.floor(coordinates.lng * 1e6);
        const restrictedLatE6 = Math.floor(geoZones.restricted.lat * 1e6);
        const restrictedLonE6 = Math.floor(geoZones.restricted.lng * 1e6);
    
        const metersLat = Math.abs(latE6 - restrictedLatE6) * 111000 / 1e6;
        const metersLon = Math.abs(lonE6 - restrictedLonE6) * 111000 / 1e6;
        const dist2 = metersLat ** 2 + metersLon ** 2;
    
        console.log("🔍 Проверка запретной зоны:", dist2, "<=", geoZones.restricted.radius ** 2);
    
        // Проверка запретной зоны (внутри updateTimer, после setCoordinates)
        if (
          dist2 <= geoZones.restricted.radius ** 2 &&
          rental.isActive &&
          !rental.isPaused &&
          !forcedPauseReason
        ) {
          clearInterval(interval); // Останавливаем интервал
          setForcedPauseReason("zone");

          try {
            await window.contract.pauseRental();
            updateStatus("⚠️ Работа приостановлена. Вы покинули рабочую зону.");
            setRental(prev => ({ ...prev, isPaused: true }));
          } catch (e) {
            console.error("Ошибка при авто-паузе:", e);
          }
        }

    
        // Автоматическое завершение
        if (correctedElapsed >= rental.fixedDuration) {
          setRental(prev => ({ ...prev, isActive: false }));
        }
    
      } catch (error) {
        console.error("Ошибка обновления таймера:", error);
      }
    };
    
  
    if (rental.isActive) {
      interval = setInterval(updateTimer, 1000);
      updateTimer(); // Немедленный вызов при монтировании
    }
  
    return () => {
      clearInterval(interval);
      setShouldResume(false);
    };
    
  }, [rental.isActive, shouldResume]);

  const resumeRentalAndRestart = async () => {
    try {
      await window.contract.resumeRental();
      updateStatus("▶ Аренда возобновлена.");
      setRental(prev => ({ ...prev, isPaused: false }));
      setShouldResume(true); // триггер перезапуска useEffect
    } catch (e) {
      console.error("Ошибка возобновления:", e);
      updateStatus("❌ Ошибка возобновления аренды.");
    }
  };
  
  

  // Обработчик паузы с интеграцией контракта
  const handlePause = async () => {
    try {
      if (rental.isPaused) {
        await window.contract.resumeRental({ gasLimit: 250000 });
      } else {
        await window.contract.pauseRental({ gasLimit: 250000 });
      }
      
      // Принудительное обновление данных
      const rentalData = await window.contract.activeRental();
      setRental(prev => ({
        ...prev,
        isPaused: rentalData.isPaused,
        totalPausedDuration: Number(rentalData.pausedDuration)
      }));
      
    } catch (error) {
      console.error("Ошибка паузы:", error);
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
  
      setRental(prev => ({
        ...prev,
        startTime: Math.floor(Date.now() / 1000),
        fixedDuration: parseInt(rental.duration),
        isActive: true,
        isPaused: false,
        totalPausedDuration: 0,
        status: "✅ Аренда началась"
      }));
  
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
      const event = receipt.events?.find(e => e.event === "RentalEnded");
      const usedSeconds = event.args.usedSeconds.toString();
      const refundAmount = formatEther(event.args.refundAmount.toString());

      setRental(prev => ({
        ...prev,
        isActive: false,
        startTime: null,
        timer: 0,
        status: `🔁 Аренда завершена. Возвращено: ${refundAmount} ETH`
      }));

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
      const status = await window.contract.getStatus();
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
      {/* Боковая панель */}
      <aside className="w-60 bg-white border-r border-gray-200 p-6">
        <h2 className="text-xl font-semibold mb-6">📦 Rental Panel</h2>
        <nav className="space-y-2 text-sm">
          <a href="#" className="block text-blue-600 font-medium">Dashboard</a>
          <a href="#" className="block text-gray-600 hover:text-blue-500">Active Rentals</a>
          <a href="#" className="block text-gray-600 hover:text-blue-500">History</a>
        </nav>
        <footer className="absolute bottom-6 left-6 text-xs text-gray-400">v1.0.0</footer>
      </aside>

      {/* Основное содержимое */}
      <main className="flex-1 p-10">
        {/* Шапка */}
        <div className="flex justify-between items-center mb-6">
          <h1 className="text-2xl font-bold">Аренда спецтехники</h1>
          
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

              <strong>Статус аренды:</strong>{" "}
              {equipment.isAvailable ? (
                <span className="text-green-600 font-medium">Готов к аренде</span>
              ) : (
                <span className="text-red-600 font-medium">Недоступно</span>
              )}
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
            <div className="space-y-1">
              <p className="text-gray-700 font-medium">
                Время аренды: {Math.min(rental.timer, rental.fixedDuration)} сек / {rental.fixedDuration} сек
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
                className="bg-yellow-500 hover:bg-yellow-600 text-white px-4 py-2 rounded-md text-sm shadow"
                >
                {rental.isPaused ? "▶ Продолжить" : "⏸ Пауза"}
                </button>

                {rental.isPaused && !forcedPauseReason && (
                <button
                  onClick={resumeRentalAndRestart}
                  className="bg-yellow-500 hover:bg-yellow-600 text-white px-4 py-2 rounded-md text-sm shadow"
                >
                  ▶ Продолжить
                </button>
              )}


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

                    {rental.isPaused && !forcedPauseReason && (
                      <button
                        onClick={handlePause}
                        className="bg-yellow-500 hover:bg-yellow-600 text-white px-4 py-2 rounded-md text-sm shadow"
                      >
                        ▶ Продолжить
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
              <p>💰 Сумма: {formatCurrency(currentCostEth)}</p>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
