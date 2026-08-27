import React, { createContext, useContext, useState, useEffect, useRef, useCallback } from 'react';
import { GameState, Player, TileData, TradeOffer, GameSettings, PlayerTokenId } from '../types/game';
import { Room, RoomMember } from '../types/room';
import { GameEngine } from '../services/gameEngine';
import { RoomService } from '../services/roomService';
import { AIService } from '../services/aiService';
import { audioService } from '../services/audioService';
import { BOARD_TILES } from '../constants/boardData';
import { useAuth } from './AuthContext';
import { AdRewardService, RewardType } from '../services/AdRewardService';

interface GameContextType {
  room: Room | null;
  gameState: GameState | null;
  isHost: boolean;
  isMyTurn: boolean;
  isMovingPawn: boolean;
  currentPlayer: Player | null;
  myPlayer: Player | null;
  selectedTileDetail: TileData | null;
  setSelectedTileDetail: (tile: TileData | null) => void;
  // Room Actions
  createRoom: (settings: GameSettings) => Promise<Room>;
  joinRoom: (roomId: string) => Promise<Room>;
  leaveRoom: () => void;
  toggleReady: () => Promise<void>;
  addBotToRoom: (difficulty: 'easy' | 'medium' | 'hard') => Promise<void>;
  removeMemberFromRoom: (memberId: string) => Promise<void>;
  updateCustomization: (token: PlayerTokenId, color: string) => Promise<void>;
  updateRoomSettings: (newSettings: Partial<GameSettings>) => Promise<void>;
  sendChatMessage: (text: string) => Promise<void>;
  startRoomGame: () => Promise<void>;
  startSinglePlayerGame: (botCount: number, botDifficulty: 'easy' | 'medium' | 'hard', settings: GameSettings) => void;
  // Game In-Play Actions
  rollDice: () => void;
  buyCurrentProperty: () => void;
  declineCurrentProperty: () => void;
  placeBid: (amount: number) => void;
  passBid: () => void;
  executeActiveCardAction: () => void;
  payJailBail: () => void;
  useJailCard: () => void;
  buildHouseOnTile: (tileId: number) => void;
  sellHouseOnTile: (tileId: number) => void;
  mortgageTile: (tileId: number) => void;
  unmortgageTile: (tileId: number) => void;
  proposeTrade: (offer: TradeOffer) => void;
  respondToTrade: (offerId: string, accept: boolean) => void;
  endCurrentTurn: () => void;
  declareBankruptcy: () => void;
  addTurnTime: (seconds: number) => void;
  grantRevival: (amount: number) => void;
  useTimeShield: () => void;
}

const GameContext = createContext<GameContextType | undefined>(undefined);

export const GameProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { user, updateUserStats } = useAuth();
  const [room, setRoom] = useState<Room | null>(null);
  const [gameState, setGameState] = useState<GameState | null>(null);
  const [selectedTileDetail, setSelectedTileDetail] = useState<TileData | null>(null);
  const [isMovingPawn, setIsMovingPawn] = useState<boolean>(false);

  const botActionTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const turnTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Subscribe to Room updates
  useEffect(() => {
    if (!room?.id) return;

    const unsub = RoomService.subscribeToRoom(room.id, (updatedRoom) => {
      setRoom(updatedRoom);
      if (updatedRoom.gameState) {
        setGameState(updatedRoom.gameState);
      }
    });

    return () => unsub();
  }, [room?.id]);

  const isHost = Boolean(room && user && room.hostId === user.uid);
  const currentPlayer = gameState ? gameState.players[gameState.currentTurnIndex] : null;
  const myPlayer = gameState && user ? gameState.players.find(p => p.id === user.uid) || null : null;
  const isMyTurn = Boolean(
    gameState && 
    currentPlayer && 
    user && 
    currentPlayer.id === user.uid && 
    !currentPlayer.isBot && 
    gameState.phase !== 'moving' && 
    !isMovingPawn
  );

  // Helper to apply and broadcast game state
  const updateAndBroadcastState = useCallback(async (newState: GameState) => {
    setGameState(newState);
    if (room) {
      await RoomService.syncGameState(room.id, newState);
    }
  }, [room]);

  // Animated Pawn Hopping Movement Runner
  const executeAnimatedRoll = useCallback(async (stateToRoll: GameState, customDice?: [number, number]) => {
    if (!stateToRoll || stateToRoll.phase === 'moving' || isMovingPawn) return;

    setIsMovingPawn(true);
    audioService.playDiceRoll();

    const prep = GameEngine.prepareRoll(stateToRoll, customDice);
    const playerId = prep.state.players[prep.state.currentTurnIndex].id;

    // First update the state with the dice roll values to trigger 3D dice animation
    await updateAndBroadcastState(prep.state);

    // Wait for the 3D dice animation to finish (approx 2 seconds)
    await new Promise(resolve => setTimeout(resolve, 2000));

    // If 3 doubles or stayed in jail, no pawn movement
    if (prep.wentToJail || prep.stayedInJail || prep.stepsToMove === 0) {
      if (prep.wentToJail) audioService.playJail();
      setIsMovingPawn(false);
      return;
    }

    // Step by step hopping animation
    let currentState = prep.state;
    const totalSteps = prep.stepsToMove;

    for (let step = 1; step <= totalSteps; step++) {
      await new Promise(resolve => setTimeout(resolve, 180));
      audioService.playStep();
      currentState = GameEngine.stepPlayerForward(currentState, playerId);
      setGameState(currentState);
    }

    // Pause on final destination tile then trigger landing action
    await new Promise(resolve => setTimeout(resolve, 220));
    const finalState = GameEngine.finishPlayerLanding(currentState, playerId);
    setIsMovingPawn(false);
    await updateAndBroadcastState(finalState);
  }, [updateAndBroadcastState, isMovingPawn]);

  // Handle Game Over stats
  useEffect(() => {
    if (gameState?.phase === 'game_over' && gameState.winnerId && user) {
      audioService.playVictory();
      const isWinner = gameState.winnerId === user.uid;
      const myP = gameState.players.find(p => p.id === user.uid);
      const netWorth = myP ? GameEngine.calculateNetWorth(myP) : 0;
      updateUserStats(isWinner, netWorth, myP?.properties.length || 0);
    }
  }, [gameState?.phase, gameState?.winnerId]);

  // 1. Live Auction Countdown Timer & Auto-Resolution
  useEffect(() => {
    if (!gameState || gameState.phase !== 'auction' || !gameState.activeAuction || gameState.isPaused) return;

    // In multiplayer rooms, only host runs the authoritative clock
    if (room && !isHost) return;

    const interval = setInterval(() => {
      setGameState(prev => {
        if (!prev || prev.phase !== 'auction' || !prev.activeAuction || prev.isPaused) return prev;
        const updated = GameEngine.tickAuctionTimer(prev);
        if (room) {
          RoomService.syncGameState(room.id, updated);
        }
        return updated;
      });
    }, 1000);

    return () => clearInterval(interval);
  }, [gameState?.phase, gameState?.activeAuction?.tileId, isHost, room?.id]);

  // 2. Dedicated Multi-Bot Auction Bidding Loop
  useEffect(() => {
    if (!gameState || gameState.phase !== 'auction' || !gameState.activeAuction || gameState.isPaused) return;

    // In multiplayer, host orchestrates bot actions
    if (room && !isHost) return;

    const auction = gameState.activeAuction;
    // Find active bot participants who are not currently the highest bidder
    const eligibleBots = gameState.players.filter(
      p => p.isBot && !p.isBankrupt && auction.activePlayerIds.includes(p.id) && auction.highestBidderId !== p.id
    );

    if (eligibleBots.length === 0) return;

    // Pick one bot to evaluate and act after a brief realistic pause (1200ms - 1700ms)
    const actingBot = eligibleBots[Math.floor(Math.random() * eligibleBots.length)];

    const botTimer = setTimeout(async () => {
      // Re-check game and auction state
      if (!gameState || gameState.phase !== 'auction' || !gameState.activeAuction) return;

      const bid = AIService.decideAuctionBid(actingBot, auction.tileId, auction.currentBid);
      if (bid !== null && bid > auction.currentBid && actingBot.cash >= bid) {
        audioService.playBid();
        const s = GameEngine.placeAuctionBid(gameState, actingBot.id, bid);
        await updateAndBroadcastState(s);
      } else {
        const s = GameEngine.passAuction(gameState, actingBot.id);
        await updateAndBroadcastState(s);
      }
    }, 1400);

    return () => clearTimeout(botTimer);
  }, [
    gameState?.phase,
    gameState?.activeAuction?.currentBid,
    gameState?.activeAuction?.highestBidderId,
    gameState?.activeAuction?.activePlayerIds?.length,
    isHost,
    room?.id
  ]);

  // 3. Regular Turn Timer Countdown
  useEffect(() => {
    if (!gameState || gameState.phase === 'game_over' || gameState.phase === 'auction' || gameState.isPaused || isMovingPawn) return;
    if (!gameState.settings?.turnTimeSeconds || gameState.settings.turnTimeSeconds === 0) return;

    // In multiplayer, only host runs the timer
    if (room && !isHost) return;

    const interval = setInterval(() => {
      setGameState(prev => {
        if (!prev || prev.phase === 'game_over' || prev.phase === 'auction' || prev.isPaused || prev.remainingTurnTime <= 0) return prev;
        
        // Pause timer if manual dialog/card is active
        if (prev.activeCard) return prev;

        const newTime = prev.remainingTurnTime - 1;
        if (newTime <= 0) {
          if (prev.phase === 'tile_action' && prev.pendingBuyTileId !== null) {
            const declined = GameEngine.declineProperty(prev, prev.pendingBuyTileId);
            if (room) RoomService.syncGameState(room.id, declined);
            return declined;
          } else {
            const ended = GameEngine.endTurn(prev);
            if (room) RoomService.syncGameState(room.id, ended);
            return ended;
          }
        }
        return { ...prev, remainingTurnTime: newTime };
      });
    }, 1000);

    return () => clearInterval(interval);
  }, [
    gameState?.currentTurnIndex, 
    gameState?.phase, 
    gameState?.pendingBuyTileId, 
    gameState?.activeCard, 
    room?.id, 
    isHost, 
    isMovingPawn
  ]);

  // Automated AI Bot Loop for Regular Turns
  useEffect(() => {
    if (!gameState || gameState.phase === 'game_over' || gameState.phase === 'auction' || !currentPlayer?.isBot || isMovingPawn) return;

    if (botActionTimeoutRef.current) clearTimeout(botActionTimeoutRef.current);

    botActionTimeoutRef.current = setTimeout(() => {
      handleBotTurnStep();
    }, 1100);

    return () => {
      if (botActionTimeoutRef.current) clearTimeout(botActionTimeoutRef.current);
    };
  }, [
    gameState?.phase, 
    gameState?.currentTurnIndex, 
    gameState?.hasRolled, 
    gameState?.pendingBuyTileId, 
    isMovingPawn
  ]);

  const handleBotTurnStep = async () => {
    if (!gameState || !currentPlayer || !currentPlayer.isBot || isMovingPawn || gameState.phase === 'auction') return;

    // 1. In Jail
    if (currentPlayer.inJail && gameState.phase === 'jail_decision') {
      const decision = AIService.decideJailAction(currentPlayer, gameState);
      if (decision === 'use_card' && currentPlayer.getOutOfJailCards > 0) {
        audioService.playCardDraw();
        const s = GameEngine.useJailCard(gameState, currentPlayer.id);
        await updateAndBroadcastState(s);
      } else if (decision === 'pay' && currentPlayer.cash >= 50) {
        audioService.playCash();
        const s = GameEngine.payJailBail(gameState, currentPlayer.id);
        await updateAndBroadcastState(s);
      } else {
        // Roll to escape
        await executeAnimatedRoll(gameState);
      }
      return;
    }

    // 2. Needs to Roll
    if (gameState.phase === 'roll_dice' && !gameState.hasRolled) {
      await executeAnimatedRoll(gameState);
      return;
    }

    // 3. Landed on Unowned Property
    if (gameState.phase === 'tile_action' && gameState.pendingBuyTileId !== null) {
      const tile = BOARD_TILES.find(t => t.id === gameState.pendingBuyTileId);
      if (tile) {
        const wantsToBuy = AIService.shouldBuyProperty(currentPlayer, tile, gameState);
        if (wantsToBuy) {
          audioService.playPropertyBuy();
          const s = GameEngine.buyProperty(gameState, currentPlayer.id, tile.id);
          await updateAndBroadcastState(s);
        } else {
          const s = GameEngine.declineProperty(gameState, tile.id);
          await updateAndBroadcastState(s);
        }
      }
      return;
    }

    // 4. Active Card Draw (Handled in ChanceCardModal)
    if (gameState.phase === 'tile_action' && gameState.activeCard) {
      return;
    }

    // 6. Idle Phase: Build houses, unmortgage properties if surplus cash & End turn
    if (gameState.phase === 'idle') {
      let currState = gameState;

      // Unmortgage if surplus cash
      const unmortgages = AIService.getPropertiesToUnmortgage(currentPlayer);
      unmortgages.forEach(tileId => {
        currState = GameEngine.unmortgageProperty(currState, currentPlayer.id, tileId);
      });

      // Build houses if possible
      const builds = AIService.getHousesToBuild(currentPlayer);
      if (builds.length > 0) {
        audioService.playBuildHouse();
        builds.forEach(b => {
          currState = GameEngine.buildHouse(currState, currentPlayer.id, b.tileId);
        });
      }

      const endedState = GameEngine.endTurn(currState);
      await updateAndBroadcastState(endedState);
    }
  };

  // --- Room Operations ---

  const createRoom = async (settings: GameSettings): Promise<Room> => {
    if (!user) throw new Error('يجب اختيار اسم المستخدم أولاً');
    const hostMember: RoomMember = {
      id: user.uid,
      name: user.displayName,
      avatar: user.photoURL || '👳‍♂️',
      token: user.selectedToken || 'falcon',
      color: '#3b82f6',
      isHost: true,
      isReady: true,
      isBot: false
    };
    const newRoom = await RoomService.createRoom(hostMember, settings);
    setRoom(newRoom);
    return newRoom;
  };

  const joinRoom = async (roomId: string): Promise<Room> => {
    if (!user) throw new Error('يجب اختيار اسم المستخدم أولاً');
    const member: RoomMember = {
      id: user.uid,
      name: user.displayName,
      avatar: user.photoURL || '🤵',
      token: user.selectedToken || 'car',
      color: '#ef4444',
      isHost: false,
      isReady: false,
      isBot: false
    };
    const updatedRoom = await RoomService.joinRoom(roomId, member);
    setRoom(updatedRoom);
    return updatedRoom;
  };

  const leaveRoom = () => {
    if (room && user) {
      RoomService.removeMember(room.id, user.uid);
    }
    setRoom(null);
    setGameState(null);
  };

  const toggleReady = async () => {
    if (room && user) {
      const updated = await RoomService.toggleReady(room.id, user.uid);
      setRoom(updated);
    }
  };

  const addBotToRoom = async (difficulty: 'easy' | 'medium' | 'hard') => {
    if (!room) return;
    const botIndex = room.members.filter(m => m.isBot).length + 1;
    const botNames = ['أبو فهد (الهامور)', 'شهاب التاجر', 'ليلى المستثمرة', 'طارق الحذر', 'سارة الدبلوماسية', 'سلطان القلعة'];
    const botAvatars = ['👳‍♂️', '🤵', '👩‍💼', '🕵️‍♂️', '🧕', '🤴'];
    const botTokens: PlayerTokenId[] = ['falcon', 'car', 'ring', 'camel', 'dallah', 'crown'];
    const botColors = ['#ef4444', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899', '#06b6d4'];

    const name = botNames[botIndex % botNames.length];
    const botMember: RoomMember = {
      id: `bot_${Date.now()}_${botIndex}`,
      name,
      avatar: botAvatars[botIndex % botAvatars.length],
      token: botTokens[botIndex % botTokens.length],
      color: botColors[botIndex % botColors.length],
      isHost: false,
      isReady: true,
      isBot: true,
      botDifficulty: difficulty
    };

    const updated = await RoomService.addBot(room.id, botMember);
    setRoom(updated);
  };

  const removeMemberFromRoom = async (memberId: string) => {
    if (room) {
      const updated = await RoomService.removeMember(room.id, memberId);
      setRoom(updated);
    }
  };

  const updateCustomization = async (token: PlayerTokenId, color: string) => {
    if (room && user) {
      const updated = await RoomService.updateMemberCustomization(room.id, user.uid, token, color);
      setRoom(updated);
    }
  };

  const updateRoomSettings = async (newSettings: Partial<GameSettings>) => {
    if (room && isHost) {
      const updated = await RoomService.updateRoomSettings(room.id, newSettings);
      if (updated) setRoom(updated);
    }
  };

  const sendChatMessage = async (text: string) => {
    if (room && user && text.trim()) {
      await RoomService.sendMessage(room.id, user.uid, user.displayName, text.trim());
    }
  };

  const startRoomGame = async () => {
    if (!room || room.members.length < 1) return;
    const initialGameState = GameEngine.createInitialGameState(room.id, room.members, room.settings);
    audioService.playCash();
    await updateAndBroadcastState(initialGameState);
  };

  const startSinglePlayerGame = (botCount: number, botDifficulty: 'easy' | 'medium' | 'hard', settings: GameSettings) => {
    const hostUser = user || {
      uid: 'player_local_1',
      displayName: 'أنت',
      photoURL: '👳‍♂️',
      selectedToken: 'falcon'
    };

    const activePerks = AdRewardService.consumeActivePerks(hostUser.uid);
    const bankBoostActive = activePerks.includes('bankBoost');

    const members: RoomMember[] = [
      {
        id: hostUser.uid,
        name: hostUser.displayName,
        avatar: hostUser.photoURL || '👳‍♂️',
        token: (hostUser.selectedToken as PlayerTokenId) || 'falcon',
        color: '#3b82f6',
        isHost: true,
        isReady: true,
        isBot: false,
        startingCashOverride: settings.startingCash * (bankBoostActive ? 1.1 : 1) // Apply 10% boost if active
      }
    ];

    const botProfiles = [
      { name: 'أبو فهد (الهامور)', avatar: '👳‍♂️', token: 'falcon', color: '#ef4444' },
      { name: 'شهاب التاجر', avatar: '🤵', token: 'car', color: '#10b981' },
      { name: 'ليلى المستثمرة', avatar: '👩‍💼', token: 'ring', color: '#f59e0b' },
      { name: 'طارق الحذر', avatar: '🕵️‍♂️', token: 'camel', color: '#8b5cf6' },
      { name: 'سارة الدبلوماسية', avatar: '🧕', token: 'dallah', color: '#ec4899' }
    ];

    for (let i = 0; i < botCount; i++) {
      const p = botProfiles[i % botProfiles.length];
      members.push({
        id: `bot_solo_${i + 1}`,
        name: p.name,
        avatar: p.avatar,
        token: p.token as PlayerTokenId,
        color: p.color,
        isHost: false,
        isReady: true,
        isBot: true,
        botDifficulty
      });
    }

    const roomId = 'SOLO-' + Math.floor(1000 + Math.random() * 9000);
    const soloRoom: Room = {
      id: roomId,
      hostId: hostUser.uid,
      status: 'in_game',
      members,
      settings,
      createdAt: Date.now(),
      messages: []
    };

    const initial = GameEngine.createInitialGameState(roomId, members, settings, activePerks);
    setRoom(soloRoom);
    setGameState(initial);
    audioService.playCash();
  };

  // --- In-Game Player Actions ---

  const rollDice = () => {
    if (!gameState || !isMyTurn || gameState.hasRolled || isMovingPawn) return;
    executeAnimatedRoll(gameState);
  };

  const buyCurrentProperty = () => {
    if (!gameState || !myPlayer || gameState.pendingBuyTileId === null || isMovingPawn) return;
    audioService.playPropertyBuy();
    const newState = GameEngine.buyProperty(gameState, myPlayer.id, gameState.pendingBuyTileId);
    updateAndBroadcastState(newState);
  };

  const declineCurrentProperty = () => {
    if (!gameState || gameState.pendingBuyTileId === null || isMovingPawn) return;
    const newState = GameEngine.declineProperty(gameState, gameState.pendingBuyTileId);
    updateAndBroadcastState(newState);
  };

  const placeBid = (amount: number) => {
    if (!gameState || !user) return;
    audioService.playBid();
    const newState = GameEngine.placeAuctionBid(gameState, user.uid, amount);
    updateAndBroadcastState(newState);
  };

  const passBid = () => {
    if (!gameState || !user) return;
    const newState = GameEngine.passAuction(gameState, user.uid);
    updateAndBroadcastState(newState);
  };

  const executeActiveCardAction = async () => {
    if (!gameState || !gameState.activeCard) return;
    const card = gameState.activeCard;
    const player = gameState.players[gameState.currentTurnIndex];

    if (!player) return;

    if (card.action.type === 'move_steps' && card.action.steps) {
      setIsMovingPawn(true);
      const steps = card.action.steps;
      let currentState = gameState;
      const absSteps = Math.abs(steps);

      for (let i = 0; i < absSteps; i++) {
        await new Promise(resolve => setTimeout(resolve, 180));
        audioService.playStep();
        if (steps > 0) {
          currentState = GameEngine.stepPlayerForward(currentState, player.id);
        } else {
          currentState = GameEngine.stepPlayerBackward(currentState, player.id);
        }
        setGameState(currentState);
      }

      await new Promise(resolve => setTimeout(resolve, 220));
      currentState.activeCard = null;
      const finalState = GameEngine.finishPlayerLanding(currentState, player.id);
      setIsMovingPawn(false);
      await updateAndBroadcastState(finalState);
      return;
    }

    if (card.action.type === 'move_to' && card.action.tileId !== undefined) {
      setIsMovingPawn(true);
      const target = card.action.tileId;
      let currentState = gameState;
      const distance = (target - player.position + 40) % 40;

      for (let i = 0; i < distance; i++) {
        await new Promise(resolve => setTimeout(resolve, 180));
        audioService.playStep();
        currentState = GameEngine.stepPlayerForward(currentState, player.id);
        setGameState(currentState);
      }

      await new Promise(resolve => setTimeout(resolve, 220));
      currentState.activeCard = null;
      const finalState = GameEngine.finishPlayerLanding(currentState, player.id);
      setIsMovingPawn(false);
      await updateAndBroadcastState(finalState);
      return;
    }

    if (card.action.type === 'advance_to_nearest_railroad' || card.action.type === 'advance_to_nearest_utility') {
      setIsMovingPawn(true);
      const targets = card.action.type === 'advance_to_nearest_railroad' ? [5, 15, 25, 35] : [12, 28];
      const nextTile = targets.find(t => t > player.position) ?? targets[0];
      const distance = (nextTile - player.position + 40) % 40;
      let currentState = gameState;

      for (let i = 0; i < distance; i++) {
        await new Promise(resolve => setTimeout(resolve, 180));
        audioService.playStep();
        currentState = GameEngine.stepPlayerForward(currentState, player.id);
        setGameState(currentState);
      }

      await new Promise(resolve => setTimeout(resolve, 220));
      currentState.activeCard = null;
      const finalState = GameEngine.finishPlayerLanding(currentState, player.id);
      setIsMovingPawn(false);
      await updateAndBroadcastState(finalState);
      return;
    }

    // Default immediate card actions
    audioService.playCardDraw();
    const newState = GameEngine.executeActiveCard(gameState);
    await updateAndBroadcastState(newState);
  };

  const payJailBail = () => {
    if (!gameState || !myPlayer || isMovingPawn) return;
    audioService.playCash();
    const newState = GameEngine.payJailBail(gameState, myPlayer.id);
    updateAndBroadcastState(newState);
  };

  const useJailCard = () => {
    if (!gameState || !myPlayer || isMovingPawn) return;
    audioService.playCardDraw();
    const newState = GameEngine.useJailCard(gameState, myPlayer.id);
    updateAndBroadcastState(newState);
  };

  const buildHouseOnTile = (tileId: number) => {
    if (!gameState || !myPlayer || isMovingPawn) return;
    audioService.playBuildHouse();
    const newState = GameEngine.buildHouse(gameState, myPlayer.id, tileId);
    updateAndBroadcastState(newState);
  };

  const sellHouseOnTile = (tileId: number) => {
    if (!gameState || !myPlayer || isMovingPawn) return;
    audioService.playCash();
    const newState = GameEngine.sellHouse(gameState, myPlayer.id, tileId);
    updateAndBroadcastState(newState);
  };

  const mortgageTile = (tileId: number) => {
    if (!gameState || !myPlayer || isMovingPawn) return;
    audioService.playCash();
    const newState = GameEngine.mortgageProperty(gameState, myPlayer.id, tileId);
    updateAndBroadcastState(newState);
  };

  const unmortgageTile = (tileId: number) => {
    if (!gameState || !myPlayer || isMovingPawn) return;
    audioService.playPropertyBuy();
    const newState = GameEngine.unmortgageProperty(gameState, myPlayer.id, tileId);
    updateAndBroadcastState(newState);
  };

  const proposeTrade = (offer: TradeOffer) => {
    if (!gameState || isMovingPawn) return;
    audioService.playClick();
    const newState = GameEngine.proposeTrade(gameState, offer);
    updateAndBroadcastState(newState);
  };

  const respondToTrade = (offerId: string, accept: boolean) => {
    if (!gameState) return;
    if (accept) audioService.playCash();
    const newState = GameEngine.respondToTrade(gameState, offerId, accept);
    updateAndBroadcastState(newState);
  };

  const endCurrentTurn = () => {
    if (!gameState || !isMyTurn || isMovingPawn) return;
    audioService.playClick();
    const newState = GameEngine.endTurn(gameState);
    updateAndBroadcastState(newState);
  };

  const declareBankruptcy = () => {
    if (!gameState || !myPlayer) return;
    audioService.playJail();
    const newState = GameEngine.handleBankruptcy(gameState, myPlayer.id);
    updateAndBroadcastState(newState);
  };

  const addTurnTime = (seconds: number) => {
    if (!gameState || !myPlayer || isMovingPawn) return;
    audioService.playClick();
    const newState = GameEngine.addTurnTime(gameState, seconds);
    updateAndBroadcastState(newState);
  };

  const grantRevival = (amount: number) => {
    if (!gameState || !myPlayer || isMovingPawn) return;
    audioService.playCash();
    const newState = GameEngine.grantRevival(gameState, myPlayer.id, amount);
    updateAndBroadcastState(newState);
  };

  const useTimeShield = useCallback(() => {
    if (!gameState || !user) return;
    const newState = GameEngine.applyTimeShield(gameState, user.uid);
    updateAndBroadcastState(newState);
  }, [gameState, user, updateAndBroadcastState]);

  return (
    <GameContext.Provider
      value={{
        room,
        gameState,
        isHost,
        isMyTurn,
        isMovingPawn,
        currentPlayer,
        myPlayer,
        selectedTileDetail,
        setSelectedTileDetail,
        createRoom,
        joinRoom,
        leaveRoom,
        toggleReady,
        addBotToRoom,
        removeMemberFromRoom,
        updateCustomization,
        updateRoomSettings,
        sendChatMessage,
        startRoomGame,
        startSinglePlayerGame,
        rollDice,
        buyCurrentProperty,
        declineCurrentProperty,
        placeBid,
        passBid,
        executeActiveCardAction,
        payJailBail,
        useJailCard,
        buildHouseOnTile,
        sellHouseOnTile,
        mortgageTile,
        unmortgageTile,
        proposeTrade,
        respondToTrade,
        endCurrentTurn,
        declareBankruptcy,
        addTurnTime,
        grantRevival,
        useTimeShield
      }}
    >
      {children}
    </GameContext.Provider>
  );
};

export const useGame = () => {
  const context = useContext(GameContext);
  if (!context) {
    throw new Error('useGame must be used within a GameProvider');
  }
  return context;
};
